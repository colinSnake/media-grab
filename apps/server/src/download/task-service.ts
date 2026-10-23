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
  TaskSnapshot,
  MediaStream,
  WsMessage,
} from '@mediagrab/shared'
import { isCancellable, isTerminal, parseMediaInput, taskDedupeKey } from '@mediagrab/shared'
import { ApiError } from '../lib/errors.js'
import type { Logger } from '../lib/logger.js'
import { silentLogger } from '../lib/logger.js'
import type { PlatformRegistry } from '../platform/registry.js'
import type { ConfigStore } from '../lib/config-store.js'
import type { TaskRepository } from '../store/repositories.js'
import { resolveDataDir, resolveDownloadDir } from '../paths.js'
import { resolveFfmpegExecutable } from '../media-tools.js'
import { DEFAULT_USER_AGENT } from '../bili/http.js'
import { checkFfmpeg, type FfmpegStatus } from './ffmpeg.js'

interface TaskServiceOptions {
  repo: TaskRepository
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

function imageExtension(stream: MediaStream): string {
  const extension = (() => { try { return path.extname(new URL(stream.url).pathname).slice(1).toLowerCase() } catch { return '' } })()
  if (['jpg', 'jpeg', 'png', 'webp', 'avif'].includes(extension)) return extension
  return ({ 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/avif': 'avif' } as Record<string, string>)[stream.mimeType ?? ''] ?? 'jpg'
}

function mediaStreamLabel(stream: MediaStream): string {
  if (stream.label !== '') return stream.label
  if (stream.width !== undefined && stream.height !== undefined) return `${stream.width}×${stream.height}`
  return stream.codecs || stream.mimeType || (stream.kind === 'audio' ? '音频资源' : stream.kind === 'image' ? '图片资源' : '视频资源')
}

function initialSnapshot(request: CreateTaskRequest): TaskSnapshot {
  const now = Date.now()
  return {
    id: randomUUID(),
    platform: request.platform ?? 'bilibili',
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
    files: [],
    error: '',
    updatedAt: now,
  }
}

export class TaskService {
  readonly #repo: TaskRepository
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
    const detected = task.input === '' ? undefined : parseMediaInput(task.input)
    if (detected !== undefined) {
      if (detected.ok) {
        if (detected.value.platform === 'unknown') throw new ApiError('INVALID_TASK', '无法识别媒体来源', 'invalid', 400)
        if (request.platform !== undefined && request.platform !== detected.value.platform) {
          throw new ApiError('INVALID_TASK', '任务来源与媒体链接平台不一致', 'invalid', 400)
        }
        if (request.platform === undefined) task.platform = detected.value.platform
      } else if (request.platform === undefined) {
        throw new ApiError('INVALID_TASK', detected.reason, 'invalid', 400)
      }
    }
    if (task.mode === 'image' && task.platform !== 'xiaohongshu') {
      throw new ApiError('INVALID_TASK', '目前仅支持小红书图文图片下载', 'invalid', 400)
    }
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
      if (parsed.platform !== task.platform) throw new ApiError('INVALID_TASK', '解析结果与任务来源不一致', 'invalid', 400)
      task.sourceId = parsed.id
      task.title = task.title || parsed.title
      task.input = parsed.input
      const requestedStream = parsed.streams.find((stream) => stream.id === task.streamId)
      const selectedKind = task.mode === 'audio' ? 'audio' : task.mode === 'image' ? 'image' : 'video'
      if (requestedStream?.kind !== selectedKind || requestedStream.available !== true) {
        const preferred = task.mode === 'audio'
          ? parsed.streams.find((stream) => stream.kind === 'audio' && stream.available)
            ?? parsed.streams.find((stream) => stream.kind === 'video' && stream.available && (stream.combined || task.platform === 'xiaohongshu'))
          : task.mode === 'image' ? parsed.streams.find((stream) => stream.kind === 'image' && stream.available)
          : parsed.streams.find((stream) => stream.kind === 'video' && stream.available && (task.mode !== 'video+audio' || stream.combined)) ?? parsed.streams.find((stream) => stream.kind === 'video' && stream.available)
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

  /** Re-evaluate queued work after a runtime setting change such as downloadPoolSize. */
  configChanged(): void {
    this.pump()
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
    const outputTemps: string[] = []

    try {
      await rm(workDir, { recursive: true, force: true })
      await mkdir(workDir, { recursive: true })
      task = this.save(task, { status: 'downloading', phase: 'pending', error: '' })
      if (task.platform === 'unknown') throw new ApiError('INVALID_TASK', '任务来源未知，无法下载', 'invalid', 400)
      const platform = task.platform
      const streamId = task.streamId
      const streams = await this.loadStreams(task, controller)
      const audio = task.mode === 'video' || task.mode === 'image' ? undefined : this.pickGenericAudio(streams, task)
      const video = task.mode === 'image' ? undefined : task.mode === 'audio'
        ? audio === undefined ? streams.find((stream) => stream.id === streamId && stream.kind === 'video' && stream.available && (stream.combined || platform === 'xiaohongshu'))
          ?? streams.find((stream) => stream.kind === 'video' && stream.available && (stream.combined || platform === 'xiaohongshu')) : undefined
        : this.pickGenericVideo(streams, task)
      const imageStreamId = task.streamId
      const image = task.mode === 'image' ? streams.find((stream) => stream.kind === 'image' && stream.id === imageStreamId && stream.available) : undefined
      const audioFromVideo = video !== undefined && audio === undefined && (video.combined || task.platform === 'xiaohongshu')
      const selectedStream = video ?? audio ?? image
      if (task.mode === 'image' && image === undefined) throw new ApiError('NO_IMAGE_STREAM', '没有找到可下载的图片', 'permission', 403)
      if ((task.mode === 'video' || task.mode === 'video+audio') && video === undefined) throw new ApiError('NO_VIDEO_STREAM', '没有找到可下载的视频流', 'permission', 403)
      if ((task.mode === 'audio' || task.mode === 'video+audio') && audio === undefined && !audioFromVideo) throw new ApiError('NO_AUDIO_STREAM', '没有找到可下载的音频流', 'permission', 403)

      let videoPath: string | undefined
      let audioPath: string | undefined
      let imagePath: string | undefined
      let imageMime: string | undefined
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

      if (image !== undefined) {
        task = this.save(this.#repo.get(id) ?? task, { phase: 'image' })
        imagePath = path.join(workDir, 'image.part')
        imageMime = await this.downloadStream(image, imagePath, task, controller, 'image')
      }

      const config = this.#config.get()
      const targetDir = resolveDownloadDir(config.savePath)
      await mkdir(targetDir, { recursive: true })
      const ext = image ? imageExtension({ ...image, mimeType: imageMime }) : extFor(task.mode, task.audioContainer)
      const imageSuffix = image ? `-${safeName(task.sourceId).slice(0, 32)}-${safeName(image.id)}` : ''
      const fileName = `${safeName(task.title)}${imageSuffix}.${ext}`
      task = this.save(this.#repo.get(id) ?? task, { phase: image ? 'done' : 'merge' })
      if (selectedStream === undefined) throw new ApiError('OUTPUT_MISSING', '下载结果不存在', 'fatal', 500)

      const files: TaskSnapshot['files'] = []
      const pending: Array<{ temp: string; output: string }> = []
      const prepare = (name: string, kind: TaskSnapshot['files'][number]['kind']) => {
        const temp = path.join(targetDir, `.${name}.${id}.tmp`)
        outputTemps.push(temp)
        pending.push({ temp, output: path.join(targetDir, name) })
        files.push({ kind, fileName: name })
        return temp
      }

      if (videoPath !== undefined && task.mode !== 'audio') {
        const videoName = task.mode === 'video+audio' ? `${safeName(task.title)}-video.mp4` : fileName
        const temp = prepare(videoName, 'video')
        if (video?.combined || task.platform === 'xiaohongshu') {
          await this.runFfmpeg(['-i', videoPath, '-map', '0:v:0', '-an', '-c:v', 'copy', '-f', 'mp4', '-y', temp], controller)
        } else {
          await this.copyFile(videoPath, temp)
        }
      }
      if (task.mode === 'audio' || task.mode === 'video+audio') {
        const source = audioPath ?? videoPath
        if (source === undefined) throw new ApiError('NO_AUDIO_STREAM', '没有找到可下载的音频流', 'permission', 403)
        const container = task.mode === 'audio' ? task.audioContainer ?? 'm4a' : 'm4a'
        const audioName = task.mode === 'video+audio' ? `${safeName(task.title)}-audio.m4a` : fileName
        const temp = prepare(audioName, 'audio')
        try {
          await this.runFfmpeg(['-i', source, '-map', '0:a:0', '-vn', '-c:a', container === 'mp3' ? 'libmp3lame' : 'copy', ...(container === 'mp3' ? ['-b:a', `${config.audioBitrateKbps}k`] : []), '-f', container === 'mp3' ? 'mp3' : 'ipod', '-y', temp], controller)
        } catch (error) {
          if (error instanceof ApiError && error.code === 'FFMPEG_FAILED' && /matches no streams|does not contain any stream/i.test(error.message)) {
            throw new ApiError('NO_AUDIO_STREAM', '视频文件没有可提取的音轨', 'permission', 403)
          }
          throw error
        }
      }
      if (imagePath !== undefined) await this.copyFile(imagePath, prepare(fileName, 'image'))
      for (const { temp } of pending) {
        if (!existsSync(temp) || (await stat(temp)).size === 0) throw new ApiError('OUTPUT_MISSING', '下载完成但输出文件不存在或为空', 'fatal', 500)
      }
      for (const { temp, output } of pending) {
        await rename(temp, output)
        outputTemps.splice(outputTemps.indexOf(temp), 1)
      }
      const saved = this.#repo.get(id) ?? task
      this.save(saved, { status: 'success', phase: 'done', fileName: files[0]?.fileName ?? '', files, error: '' })
    } catch (error) {
      const current = this.#repo.get(id) ?? task
      if (controller.signal.aborted) this.save(current, { status: 'stopped', error: '任务已取消' })
      else this.save(current, { status: 'fail', error: error instanceof Error ? error.message : String(error) })
    } finally {
      await rm(workDir, { recursive: true, force: true })
      for (const temp of outputTemps) await rm(temp, { force: true })
    }
  }

  private pickGenericVideo(streams: readonly MediaStream[], task: TaskSnapshot): MediaStream | undefined {
    const available = streams.filter((stream) => stream.available)
    if (task.streamId !== undefined) {
      const selected = available.find((stream) => stream.id === task.streamId && stream.kind === 'video')
      if (selected !== undefined) return selected
    }
    if (task.qn !== undefined) {
      const selected = available.find((stream) => stream.id === `video:${task.qn}` || stream.id === String(task.qn))
      if (selected !== undefined) return selected
    }
    return available.find((stream) => stream.kind === 'video' && (task.mode !== 'video+audio' || stream.combined)) ?? available.find((stream) => stream.kind === 'video')
  }

  private async loadStreams(task: TaskSnapshot, controller: AbortController): Promise<MediaStream[]> {
    const media = this.#media as unknown as {
      streamsForDownload?: (options: { platform: Exclude<TaskSnapshot['platform'], 'unknown'>; input: string; bvid?: string; cid?: number; signal?: AbortSignal }) => Promise<MediaStream[]>
    }
    if (media.streamsForDownload !== undefined) {
      if (task.platform === 'unknown') throw new ApiError('INVALID_TASK', '任务来源未知，无法下载', 'invalid', 400)
      return media.streamsForDownload({ platform: task.platform, input: task.input, bvid: task.bvid, cid: task.cid, signal: controller.signal })
    }
    const parsed = await this.#media.parse(task.input)
    return parsed.streams
  }

  private pickGenericAudio(streams: readonly MediaStream[], task: TaskSnapshot): MediaStream | undefined {
    const available = streams.filter((stream) => stream.available)
    if (task.mode === 'audio' && task.streamId !== undefined) {
      const selected = available.find((stream) => stream.id === task.streamId && stream.kind === 'audio')
      if (selected !== undefined) return selected
    }
    return available.find((stream) => stream.kind === 'audio')
  }

  private async downloadStream(
    stream: MediaStream,
    target: string,
    task: TaskSnapshot,
    controller: AbortController,
    phase: 'video' | 'audio' | 'image',
  ): Promise<string> {
    const formatHeaders = 'httpHeaders' in stream ? stream.httpHeaders ?? {} : {}
    const headers = new Headers({ 'User-Agent': DEFAULT_USER_AGENT })
    for (const [name, value] of Object.entries(formatHeaders)) headers.set(name, value)
    if (!headers.has('referer')) headers.set('Referer', task.input)
    const urls = [...new Set([stream.url, ...stream.backupUrls])]
    let response: Response | undefined
    let lastError: unknown
    for (const url of urls) {
      try {
        const candidate = await this.#fetch(url, { headers, signal: controller.signal })
        if (candidate.ok && candidate.body !== null) {
          response = candidate
          break
        }
        await candidate.body?.cancel().catch(() => {})
        lastError = new Error(`HTTP ${candidate.status}`)
      } catch (error) {
        if (controller.signal.aborted) throw error
        lastError = error
      }
    }
    if (response === undefined || response.body === null) {
      const detail = lastError instanceof Error ? lastError.message : '未知错误'
      throw new ApiError('STREAM_FETCH_FAILED', `取流失败（${detail}）`, 'network', 502)
    }
    const contentType = (response.headers.get('content-type') ?? '').split(';', 1)[0]?.trim().toLowerCase() ?? ''
    if (stream.kind === 'image' && contentType !== '' && !['image/jpeg', 'image/png', 'image/webp', 'image/avif', 'application/octet-stream'].includes(contentType)) {
      await response.body.cancel().catch(() => {})
      throw new ApiError('INVALID_IMAGE_RESPONSE', '图片资源返回了非图片内容', 'network', 502)
    }
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
    return contentType
  }

  private async copyFile(from: string, to: string): Promise<void> {
    if (!existsSync(from)) throw new ApiError('OUTPUT_MISSING', '下载临时文件不存在', 'fatal', 500)
    const source = await stat(from)
    if (source.size === 0) throw new ApiError('OUTPUT_EMPTY', '下载结果为空', 'fatal', 500)
    const { copyFile } = await import('node:fs/promises')
    await copyFile(from, to)
  }

  private async runFfmpeg(args: string[], controller: AbortController): Promise<void> {
    const executable = resolveFfmpegExecutable(this.#config.get().ffmpegPath)
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
