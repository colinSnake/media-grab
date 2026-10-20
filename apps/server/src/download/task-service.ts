import { randomUUID } from 'node:crypto'
import { createWriteStream, existsSync } from 'node:fs'
import { mkdir, rename, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { once } from 'node:events'
import { spawn } from 'node:child_process'
import type {
  AppConfig,
  CreateTaskRequest,
  CreateTaskResponse,
  DownloadMode,
  StreamSummary,
  TaskSnapshot,
  MediaStream,
  WsMessage,
} from '@mediagrab/shared'
import { isCancellable, isTerminal, taskDedupeKey } from '@mediagrab/shared'
import { ApiError } from '../lib/errors.js'
import type { Logger } from '../lib/logger.js'
import { silentLogger } from '../lib/logger.js'
import type { BiliClient } from '../bili/client.js'
import type { PlatformRegistry } from '../platform/registry.js'
import type { ConfigStore } from '../lib/config-store.js'
import type { TaskRepository } from '../store/repositories.js'
import { resolveDataDir, resolveDownloadDir } from '../paths.js'
import { DEFAULT_USER_AGENT, biliVideoReferer } from '../bili/http.js'
import { checkFfmpeg, type FfmpegStatus } from './ffmpeg.js'

interface TaskServiceOptions {
  repo: TaskRepository
  bili: BiliClient
  platforms: PlatformRegistry
  media: import('../platform/registry.js').MediaRegistry
  config: ConfigStore
  logger?: Logger
  fetchImpl: typeof fetch
  dataDir?: string
}

interface ActiveTask {
  controller: AbortController
}

function safeName(value: string): string {
  const cleaned = value
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\.+$/g, '')
  return cleaned.slice(0, 160) || 'mediaGrab-download'
}

function extFor(mode: DownloadMode, audioContainer: 'm4a' | 'mp3' | undefined): string {
  if (mode === 'audio') return audioContainer === 'mp3' ? 'mp3' : 'm4a'
  return 'mp4'
}

function mediaStreamLabel(stream: MediaStream): string {
  if (stream.label !== '') return stream.label
  if (stream.width !== undefined && stream.height !== undefined) return `${stream.width}×${stream.height}`
  return stream.codecs || stream.mimeType || (stream.kind === 'audio' ? '音频资源' : '视频资源')
}

function initialSnapshot(request: CreateTaskRequest): TaskSnapshot {
  const now = Date.now()
  return {
    id: randomUUID(),
    platform: request.platform,
    input: request.input ?? '',
    sourceId: '',
    bvid: request.bvid ?? '',
    cid: request.cid ?? 0,
    title: request.title,
    status: 'waiting',
    phase: 'pending',
    mode: request.mode,
    audioContainer: request.audioContainer,
    qn: request.qn,
    streamId: request.streamId,
    qualityLabel: request.qualityLabel,
    dedupeKey: undefined,
    totalBytes: 0,
    downloadedBytes: 0,
    speedBps: 0,
    fileName: '',
    error: '',
    updatedAt: now,
  }
}

export class TaskService {
  readonly #repo: TaskRepository
  readonly #bili: BiliClient
  readonly #platforms: PlatformRegistry
  readonly #media: import('../platform/registry.js').MediaRegistry
  readonly #config: ConfigStore
  readonly #logger: Logger
  readonly #fetch: typeof fetch
  readonly #dataDir: string
  readonly #active = new Map<string, ActiveTask>()
  readonly #queued = new Set<string>()
  readonly #listeners = new Set<(event: WsMessage) => void>()
  #createTail: Promise<void> = Promise.resolve()
  #runningCount = 0

  constructor(options: TaskServiceOptions) {
    this.#repo = options.repo
    this.#bili = options.bili
    this.#platforms = options.platforms
    this.#media = options.media
    this.#config = options.config
    this.#logger = options.logger ?? silentLogger
    this.#fetch = options.fetchImpl
    this.#dataDir = options.dataDir ?? resolveDataDir()
    this.recoverInterrupted()
  }

  list(): TaskSnapshot[] {
    const seen = new Set<string>()
    return this.#repo.list().filter((task) => {
      const key = taskDedupeKey(task)
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
  }

  get(id: string): TaskSnapshot | null {
    return this.#repo.get(id)
  }

  subscribe(listener: (event: WsMessage) => void): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  async create(request: CreateTaskRequest): Promise<CreateTaskResponse> {
    const task = initialSnapshot(request)
    if (task.platform === 'bilibili' && (task.bvid === '' || task.cid === 0)) {
      if (task.input === '') {
        throw new ApiError('INVALID_TASK', '任务缺少 B站链接或 bvid/cid', 'invalid', 400)
      }
      const parsed = await this.#platforms.parse(task.input)
      task.bvid = parsed.bvid
      task.cid = parsed.cid
      task.title = task.title || parsed.title
      task.input = parsed.input
      task.sourceId = task.bvid
    } else if (task.platform !== 'bilibili') {
      if (task.input === '') throw new ApiError('INVALID_TASK', '任务缺少媒体链接', 'invalid', 400)
      const parsed = await this.#media.parse(task.input)
      task.sourceId = parsed.id
      task.title = task.title || parsed.title
      task.input = parsed.input
      const requestedStream = parsed.streams.find((stream) => stream.id === task.streamId)
      const selectedKind = task.mode === 'audio' ? 'audio' : 'video'
      if (requestedStream?.kind !== selectedKind) {
        const preferred = task.mode === 'audio'
          ? parsed.streams.find((stream) => stream.kind === 'audio')
          : parsed.streams.find((stream) => stream.kind === 'video' && (task.mode !== 'video+audio' || stream.combined)) ?? parsed.streams.find((stream) => stream.kind === 'video')
        task.streamId = preferred?.id
      }
      const selected = parsed.streams.find((stream) => stream.id === task.streamId)
      if (selected !== undefined) task.qualityLabel = mediaStreamLabel(selected)
    }
    if (task.title === '') task.title = task.bvid
    task.dedupeKey = taskDedupeKey(task)
    const release = await this.acquireCreateLock()
    try {
      const duplicate = this.#repo.list().find((item) => taskDedupeKey(item) === task.dedupeKey)
      if (duplicate !== undefined) return { task: duplicate, deduplicated: true }
      this.#repo.save(task)
      const active: ActiveTask = { controller: new AbortController() }
      this.#active.set(task.id, active)
      this.#queued.add(task.id)
      this.pump()
      return { task, deduplicated: false }
    } finally {
      release()
    }
  }

  cancel(id: string): TaskSnapshot | null {
    const task = this.#repo.get(id)
    if (task === null) return null
    if (!isCancellable(task.status)) return task
    const active = this.#active.get(id)
    if (active !== undefined) {
      active.controller.abort()
      if (this.#queued.delete(id)) {
        this.#active.delete(id)
        this.save(task, { status: 'stopped', phase: 'pending', error: '任务已取消' })
        this.pump()
      }
    } else {
      this.save(task, { status: 'stopped', error: '任务已取消' })
    }
    return this.#repo.get(id)
  }

  retry(id: string): TaskSnapshot | null {
    const task = this.#repo.get(id)
    if (task === null || !isTerminal(task.status) || task.status === 'success') return task
    const next = this.save(task, { status: 'waiting', phase: 'pending', error: '', downloadedBytes: 0, totalBytes: 0, speedBps: 0 })
    const active: ActiveTask = { controller: new AbortController() }
    this.#active.set(id, active)
    this.#queued.add(id)
    this.pump()
    return next
  }

  remove(id: string): boolean {
    const task = this.#repo.get(id)
    if (task === null) return false
    const matches = this.#repo.list().filter((item) => taskDedupeKey(item) === taskDedupeKey(task))
    if (matches.some((item) => this.#active.has(item.id))) return false
    for (const match of matches) {
      this.#repo.delete(match.id)
      this.emit({ type: 'task-removed', id: match.id })
    }
    return true
  }

  private async acquireCreateLock(): Promise<() => void> {
    const previous = this.#createTail
    let release!: () => void
    this.#createTail = new Promise<void>((resolve) => { release = resolve })
    await previous
    return release
  }

  /** 按配置限制同时运行的下载任务，等待中的任务仍然持久化为 waiting。 */
  private pump(): void {
    const configuredPoolSize = this.#config.get().downloadPoolSize
    const poolSize = typeof configuredPoolSize === 'number' && configuredPoolSize > 0 ? configuredPoolSize : 1
    while (this.#runningCount < poolSize && this.#queued.size > 0) {
      const id = this.#queued.values().next().value as string | undefined
      if (id === undefined) return
      this.#queued.delete(id)
      const active = this.#active.get(id)
      const task = this.#repo.get(id)
      if (active === undefined || task === null || !isCancellable(task.status)) {
        this.#active.delete(id)
        continue
      }

      this.#runningCount += 1
      void this.run(id, active.controller)
        .catch((error: unknown) => {
          this.#logger.error({ error: error instanceof Error ? error.message : String(error) }, '下载任务异常')
        })
        .finally(() => {
          this.#active.delete(id)
          this.#runningCount = Math.max(0, this.#runningCount - 1)
          this.pump()
        })
    }
  }

  ffmpegStatus(): Promise<FfmpegStatus> {
    return checkFfmpeg(this.#config.get().ffmpegPath)
  }

  recoverInterrupted(): void {
    for (const task of this.#repo.list()) {
      if (task.status === 'waiting' || task.status === 'downloading' || task.status === 'merging') {
        this.save(task, { status: 'fail', error: '应用上次退出时任务未完成，可点击重试' })
      }
    }
  }

  private save(task: TaskSnapshot, patch: Partial<TaskSnapshot>): TaskSnapshot {
    const next: TaskSnapshot = { ...task, ...patch, updatedAt: Date.now() }
    this.#repo.save(next)
    this.emit({ type: 'task-update', task: next })
    return next
  }

  private emit(event: WsMessage): void {
    for (const listener of this.#listeners) {
      try {
        listener(event)
      } catch {
        this.#listeners.delete(listener)
      }
    }
  }

  private async run(id: string, controller: AbortController): Promise<void> {
    let task = this.#repo.get(id)
    if (task === null) return
    const workDir = path.join(this.#dataDir, 'tasks', id)
    let outputTemp: string | undefined

    try {
      await rm(workDir, { recursive: true, force: true })
      await mkdir(workDir, { recursive: true })
      task = this.save(task, { status: 'downloading', phase: 'pending', error: '' })
      const bundle = task.platform === 'bilibili' ? await this.#bili.playurl(task.bvid, task.cid, { signal: controller.signal }) : undefined
      const generic = task.platform === 'bilibili' ? undefined : await this.#media.parse(task.input)
      const genericVideo = generic === undefined || task.mode === 'audio' ? undefined : this.pickGenericVideo(generic.streams, task)
      const genericAudio = generic === undefined || task.mode === 'video' || (task.mode === 'video+audio' && genericVideo?.combined === true) ? undefined : this.pickGenericAudio(generic.streams, task)
      const genericStream = genericVideo ?? genericAudio
      const video = genericVideo ?? (task.platform === 'bilibili' ? this.pickVideo(bundle?.video ?? [], task) : undefined)
      const audio = genericAudio ?? (task.platform === 'bilibili' ? bundle?.audio[0] : undefined)
      if (task.mode !== 'audio' && video === undefined) throw new ApiError('NO_VIDEO_STREAM', '没有找到可下载的视频流', 'permission', 403)
      const separateAudioRequired = task.mode !== 'video' && genericVideo?.combined !== true
      if (separateAudioRequired && audio === undefined) throw new ApiError('NO_AUDIO_STREAM', '没有找到可下载的音频流', 'permission', 403)

      let videoPath: string | undefined
      let audioPath: string | undefined
      if (video !== undefined) {
        task = this.save(task, { phase: 'video' })
        videoPath = path.join(workDir, 'video.part')
        await this.downloadStream(video, videoPath, task, controller, 'video')
      }
      if (audio !== undefined) {
        task = this.save(this.#repo.get(id) ?? task, { phase: 'audio' })
        audioPath = path.join(workDir, 'audio.part')
        await this.downloadStream(audio, audioPath, task, controller, 'audio')
      }

      const config = this.#config.get()
      const targetDir = resolveDownloadDir(config.savePath)
      await mkdir(targetDir, { recursive: true })
      const ext = extFor(task.mode, task.audioContainer)
      const fileName = `${safeName(task.title)}.${ext}`
      const output = path.join(targetDir, fileName)
      outputTemp = path.join(targetDir, `.${fileName}.${id}.tmp`)
      task = this.save(this.#repo.get(id) ?? task, { phase: task.mode === 'video+audio' || (task.mode === 'audio' && task.audioContainer === 'mp3') ? 'merge' : 'done' })

      if (task.platform !== 'bilibili' && genericStream !== undefined) {
        const genericPath = videoPath ?? audioPath ?? ''
        if (task.mode === 'video+audio' && genericVideo?.combined !== true && videoPath !== undefined && audioPath !== undefined) {
          await this.runFfmpeg([
            '-i', videoPath,
            '-i', audioPath,
            '-map', '0:v:0',
            '-map', '1:a:0',
            '-c:v', 'copy',
            '-c:a', 'copy',
            '-shortest',
            '-movflags', '+faststart',
            '-y', outputTemp,
          ], controller)
        } else if (task.mode === 'audio' && task.audioContainer === 'mp3') {
          await this.runFfmpeg([ '-i', genericPath, '-vn', '-c:a', 'libmp3lame', '-b:a', `${config.audioBitrateKbps}k`, '-y', outputTemp ], controller)
        } else {
          await this.copyFile(genericPath, outputTemp)
        }
      } else if (task.mode === 'video+audio') {
        await this.runFfmpeg([
          '-i', videoPath ?? '',
          '-i', audioPath ?? '',
          '-map', '0:v:0',
          '-map', '1:a:0',
          '-c:v', 'copy',
          '-c:a', 'copy',
          '-shortest',
          '-movflags', '+faststart',
          '-y', outputTemp,
        ], controller)
      } else if (task.mode === 'audio' && task.audioContainer === 'mp3') {
        await this.runFfmpeg([ '-i', audioPath ?? '', '-vn', '-c:a', 'libmp3lame', '-b:a', `${config.audioBitrateKbps}k`, '-y', outputTemp ], controller)
      } else if (task.mode === 'video') {
        await this.runFfmpeg([ '-i', videoPath ?? '', '-c', 'copy', '-movflags', '+faststart', '-y', outputTemp ], controller)
      } else if (task.mode === 'audio') {
        await this.runFfmpeg([ '-i', audioPath ?? '', '-vn', '-c:a', 'copy', '-y', outputTemp ], controller)
      } else {
        await this.copyFile(videoPath ?? audioPath ?? '', outputTemp)
      }

      if (!existsSync(outputTemp) || (await stat(outputTemp)).size === 0) {
        throw new ApiError('OUTPUT_MISSING', '下载完成但输出文件不存在或为空', 'fatal', 500)
      }
      await rename(outputTemp, output)
      outputTemp = undefined
      const saved = this.#repo.get(id) ?? task
      this.save(saved, { status: 'success', phase: 'done', fileName, error: '' })
    } catch (error) {
      const current = this.#repo.get(id) ?? task
      if (controller.signal.aborted) this.save(current, { status: 'stopped', error: '任务已取消' })
      else this.save(current, { status: 'fail', error: error instanceof Error ? error.message : String(error) })
    } finally {
      await rm(workDir, { recursive: true, force: true })
      if (outputTemp !== undefined) await rm(outputTemp, { force: true })
    }
  }

  private pickVideo(streams: readonly StreamSummary[], task: TaskSnapshot): StreamSummary | undefined {
    if (task.qn !== undefined) return streams.find((stream) => stream.id === task.qn) ?? streams[0]
    return streams[0]
  }

  private pickGenericVideo(streams: readonly MediaStream[], task: TaskSnapshot): MediaStream | undefined {
    if (task.streamId !== undefined) {
      const selected = streams.find((stream) => stream.id === task.streamId && stream.kind === 'video')
      if (selected !== undefined) return selected
    }
    return streams.find((stream) => stream.kind === 'video' && (task.mode !== 'video+audio' || stream.combined)) ?? streams.find((stream) => stream.kind === 'video')
  }

  private pickGenericAudio(streams: readonly MediaStream[], task: TaskSnapshot): MediaStream | undefined {
    if (task.mode === 'audio' && task.streamId !== undefined) return streams.find((stream) => stream.id === task.streamId && stream.kind === 'audio')
    return streams.find((stream) => stream.kind === 'audio')
  }

  private async downloadStream(
    stream: StreamSummary | MediaStream,
    target: string,
    task: TaskSnapshot,
    controller: AbortController,
    phase: 'video' | 'audio',
  ): Promise<void> {
    const response = await this.#fetch(stream.url, {
      headers: { Referer: task.platform === 'bilibili' ? biliVideoReferer(task.bvid) : task.input, 'User-Agent': DEFAULT_USER_AGENT },
      signal: controller.signal,
    })
    if (!response.ok || response.body === null) throw new ApiError('STREAM_FETCH_FAILED', `取流失败（HTTP ${response.status}）`, 'network', 502)
    const total = Number(response.headers.get('content-length') ?? 0)
    const phaseBaseBytes = this.#repo.get(task.id)?.totalBytes ?? 0
    const file = createWriteStream(target)
    const reader = response.body.getReader()
    let downloaded = 0
    const started = Date.now()
    try {
      while (true) {
        const next = await reader.read()
        if (next.done) break
        downloaded += next.value.byteLength
        if (!file.write(next.value)) await once(file, 'drain')
        const current = this.#repo.get(task.id)
        if (current !== null) {
          const totalBytes = total > 0 ? phaseBaseBytes + total : 0
          this.save(current, { totalBytes, downloadedBytes: current.downloadedBytes + next.value.byteLength, speedBps: Math.round(downloaded / Math.max(1, (Date.now() - started) / 1000)), phase })
        }
      }
    } finally {
      file.end()
      await once(file, 'close').catch(() => {})
      reader.releaseLock()
    }
  }

  private async copyFile(from: string, to: string): Promise<void> {
    if (!existsSync(from)) throw new ApiError('OUTPUT_MISSING', '下载临时文件不存在', 'fatal', 500)
    const source = await stat(from)
    if (source.size === 0) throw new ApiError('OUTPUT_EMPTY', '下载结果为空', 'fatal', 500)
    const { copyFile } = await import('node:fs/promises')
    await copyFile(from, to)
  }

  private async runFfmpeg(args: string[], controller: AbortController): Promise<void> {
    const executable = this.#config.get().ffmpegPath.trim() || 'ffmpeg'
    const child = spawn(executable, args, { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr?.on('data', (chunk: Buffer) => { stderr = `${stderr}${chunk.toString()}`.slice(-4_000) })
    const abort = () => child.kill('SIGTERM')
    controller.signal.addEventListener('abort', abort, { once: true })
    try {
      const [code] = (await once(child, 'close')) as [number | null]
      if (code !== 0) throw new ApiError('FFMPEG_FAILED', stderr.trim() || `FFmpeg 退出码 ${code ?? 'unknown'}`, 'fatal', 500)
    } catch (error) {
      if (controller.signal.aborted) throw new ApiError('TASK_CANCELLED', '任务已取消', 'invalid', 400)
      throw error
    } finally {
      controller.signal.removeEventListener('abort', abort)
    }
  }
}
