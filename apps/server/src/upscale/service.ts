import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { access, lstat, realpath, stat, mkdtemp, writeFile, link, rm, readFile } from 'node:fs/promises'
import path from 'node:path'
import { upscaleCreateSchema, type RepairStrokes, type UpscaleCreate, type UpscaleEvent, type UpscaleKind, type UpscaleMedia, type UpscaleTask } from '@mediagrab/shared'
import type { Database } from '../store/db.js'
import { ApiError } from '../lib/errors.js'
import { Processes } from './process.js'
import { capability } from './tools.js'
import { inspect, inspectImage, supportedImage, supportedMedia, timeline } from './probe.js'
import { checkSpace, pipeline, videoHash } from './pipeline.js'
import { imagePipeline } from './image-pipeline.js'
import { checkAtomicOutput } from './output.js'
import { insideWork, upscaleRecordSchema } from './record.js'
import { firstFrame } from './thumbnail.js'
import { repairImagePreview } from './inpainting.js'
import { repairCapability } from './repair-capability.js'

export function invalid(message: string, statusCode = 400): Error & { statusCode: number } { return Object.assign(new Error(message), { statusCode }) }
export async function inputIdentity(file: string, kind: UpscaleKind = 'video'): Promise<string> {
  const accepted = kind === 'image' ? /\.(?:png|jpe?g)$/i.test(file) : /\.mp4$/i.test(file)
  if (!path.isAbsolute(file) || !accepted) throw invalid(kind === 'image' ? '仅接受本地 PNG/JPG/JPEG 图片绝对路径' : '仅接受本地 MP4 绝对路径')
  const info = await lstat(file)
  if (!info.isFile() || info.isSymbolicLink() || await realpath(file) !== file) throw invalid('仅接受普通文件的规范路径，不支持符号链接')
  await access(file, constants.R_OK)
  // access(R_OK) under a privileged test runner must not make a mode-000 file acceptable.
  if (!(info.mode & 0o444)) throw invalid('输入文件不可读')
  return `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`
}
async function outputDirectory(directory: string): Promise<string> {
  if (!path.isAbsolute(directory) || await realpath(directory) !== directory || !(await lstat(directory)).isDirectory()) throw invalid('输出目录必须是已存在的普通规范目录')
  await access(directory, constants.W_OK | constants.X_OK)
  return directory
}
function isStorageFull(cause: unknown, depth = 0): boolean {
  if (!cause || depth > 5) return false
  const error = cause as NodeJS.ErrnoException & { cause?: unknown }
  return /SQLITE_FULL|ENOSPC|EDQUOT|database or disk is full|disk.*full|No space left on device|Disk quota exceeded/i.test(error.message ?? String(cause))
    || ['ENOSPC', 'EDQUOT', 'SQLITE_FULL'].includes(String(error.code)) || isStorageFull(error.cause, depth + 1)
}
function storageFailure(cause: unknown): Error & { statusCode: number; code: string } {
  const full = isStorageFull(cause)
  const code = full ? 'STORAGE_FULL' : 'STORAGE_ERROR'
  const message = full ? '存储空间不足，已暂停新任务；请释放空间后点击重新检查' : '任务记录写入失败，已暂停新任务；请检查数据目录后点击重新检查'
  return Object.assign(new ApiError(code, message, 'fatal', 503), { statusCode: 503, cause })
}
interface Grant { input: string; directory: string; identity: string; kind: UpscaleKind; media: UpscaleMedia; expires: number }
interface Record { task: UpscaleTask; identity: string; repair?: RepairStrokes; work?: string; pendingOutput?: NonNullable<UpscaleTask['result']> }
export class UpscaleService {
  private records = new Map<string, Record>()
  private grants = new Map<string, Grant>()
  private repairPreviews = new Map<string, string>()
  private preview?: { abort: AbortController; promise: Promise<Buffer> }
  private storageError?: ReturnType<typeof storageFailure>
  private dirty = new Set<Record>()
  private outputErrors = new Map<string, ReturnType<typeof storageFailure>>()
  private recovery?: Promise<void>
  private get blockedStorage() { return this.storageError ?? this.outputErrors.values().next().value }
  private thumbnails = new Map<string, Buffer>()
  private thumbnailRequests = new Map<string, Promise<Buffer>>()
  private thumbnailTail: Promise<void> = Promise.resolve()
  private thumbnailBusy = false
  private listeners = new Set<(event: UpscaleEvent) => void>()
  private active?: { id: string; abort: AbortController; promise: Promise<void>; committing: boolean }
  private shutdown = new AbortController()
  private closing = false
  private ready: Promise<void>
  private capabilityPromise?: ReturnType<typeof capability>
  constructor(private db: Database) {
    const recovered: Record[] = []
    for (const row of db.prepare('SELECT id,snapshot FROM upscale_tasks ORDER BY created_at').all()) {
      let record: Record
      try {
        record = upscaleRecordSchema.parse(JSON.parse(String(row.snapshot)))
        if (record.task.id !== row.id) throw new Error('Task ID mismatch')
      } catch {
        // Preserve the row for diagnosis; never delete files based on an invalid snapshot.
        console.warn('[upscale] 忽略损坏或不兼容的任务记录，保留原记录供恢复')
        continue
      }
      this.records.set(record.task.id, record)
      if (['queued', 'running'].includes(record.task.status)) {
        record.task.status = 'interrupted'; record.task.error = { code: 'INTERRUPTED', message: '上次运行被中断，请重新选择文件创建任务；不支持断点续算' }
        if (!record.pendingOutput) this.safeSave(record)
      }
      // A crash after saving a terminal state but before finally{} must not leak frames.
      if (record.work) recovered.push(record)
    }
    this.ready = Promise.all(recovered.map((r) => this.recoverOutput(r))).then(() => {})
  }
  async capabilities(refresh = false): ReturnType<typeof capability> {
    if (refresh) {
      this.capabilityPromise = undefined
      await this.recoverStorage()
    }
    this.capabilityPromise ??= capability(this.shutdown.signal).then((result) => { if (!result.tools) this.capabilityPromise = undefined; return result })
    const result = await this.capabilityPromise
    return { ...result, capability: { ...result.capability, ...(this.blockedStorage ? { storageReason: this.blockedStorage.message } : {}) } }
  }
  get storageReason(): string | undefined { return this.blockedStorage?.message }
  list(): UpscaleTask[] { return [...this.records.values()].map((r) => structuredClone(r.task)).reverse().slice(0, 100) }
  get(id: string): UpscaleTask { const r = this.records.get(id); if (!r) throw invalid('超分任务不存在', 404); return structuredClone(r.task) }
  async thumbnail(id: string): Promise<Buffer> {
    await this.ready
    if (this.closing) throw invalid('服务正在关闭', 503)
    const record = this.records.get(id)
    if (!record) throw invalid('超分任务不存在', 404)
    const verify = async () => {
      if (await inputIdentity(record.task.input, record.task.kind ?? 'video') !== record.identity) throw invalid('源文件发生变化，无法读取封面', 409)
      if (this.records.get(id) !== record) throw invalid('超分任务不存在', 404)
    }
    await verify()
    const cached = this.thumbnails.get(id)
    if (cached) { this.thumbnails.delete(id); this.thumbnails.set(id, cached); return cached }
    const existing = this.thumbnailRequests.get(id)
    if (existing) return existing
    // Serialize tiny decodes so scrolling a long queue cannot compete with inference.
    if (this.thumbnailRequests.size >= 8) throw invalid('封面加载繁忙，请稍后重试', 429)
    const request = this.thumbnailTail.then(async () => {
      this.thumbnailBusy = true
      try {
        while (this.active || this.preview) await (this.active?.promise ?? this.preview!.promise).catch(() => {})
        this.shutdown.signal.throwIfAborted()
        await verify()
        const { tools } = await this.capabilities()
        if (!tools) throw invalid('本地视频解码引擎不可用', 503)
        const image = await firstFrame(tools.ffmpeg, record.task.input, this.shutdown.signal, record.task.kind ?? 'video')
        await verify()
        this.thumbnails.set(id, image)
        if (this.thumbnails.size > 32) this.thumbnails.delete(this.thumbnails.keys().next().value!)
        return image
      } finally {
        this.thumbnailBusy = false
        this.pump()
      }
    }).finally(() => { this.thumbnailRequests.delete(id) })
    this.thumbnailRequests.set(id, request)
    this.thumbnailTail = request.then(() => {}, () => {})
    return request
  }
  async grantThumbnail(id: string): Promise<Buffer> {
    const grant = this.grants.get(id)
    if (!grant || grant.expires < Date.now() || grant.kind !== 'image') throw invalid('图片授权已失效，请重新选择文件', 403)
    if (await inputIdentity(grant.input, grant.kind) !== grant.identity) throw invalid('源图片发生变化，请重新选择')
    const { tools } = await this.capabilities()
    if (!tools) throw invalid('本地图片处理依赖不可用', 503)
    return firstFrame(tools.ffmpeg, grant.input, this.shutdown.signal, 'image', true)
  }
  repairPreview(id: string, strokes: RepairStrokes, signal?: AbortSignal): Promise<Buffer> {
    if (this.closing) return Promise.reject(invalid('服务正在关闭', 503))
    if (this.blockedStorage) return Promise.reject(this.blockedStorage)
    if (this.active || this.thumbnailBusy || this.preview) return Promise.reject(invalid('当前正在处理媒体，请等待任务结束后再生成修补预览', 429))
    const abort = new AbortController()
    const cancel = () => abort.abort()
    signal?.addEventListener('abort', cancel, { once: true })
    if (signal?.aborted) abort.abort()
    // Acquire synchronously before filesystem awaits; pump() observes this lease.
    const state = { abort, promise: Promise.resolve(Buffer.alloc(0)) as Promise<Buffer> }
    this.preview = state
    state.promise = this.generateRepairPreview(id, strokes, abort.signal).finally(() => {
      signal?.removeEventListener('abort', cancel)
      if (this.preview === state) this.preview = undefined
      this.pump()
    })
    return state.promise
  }
  private async generateRepairPreview(id: string, strokes: RepairStrokes, signal: AbortSignal): Promise<Buffer> {
    signal.throwIfAborted()
    const grant = this.grants.get(id)
    if (!grant || grant.expires < Date.now() || grant.kind !== 'image') throw invalid('图片授权已失效，请重新选择文件', 403)
    if (await inputIdentity(grant.input, grant.kind) !== grant.identity) throw invalid('源图片发生变化，请重新选择')
    const { tools, capability: cap } = await this.capabilities()
    if (!tools) throw invalid('本地图片处理依赖不可用', 503)
    if (!cap.repairAvailable) throw invalid(cap.repairReason ?? '图片修补不可用', 503)
    // Model files can change after the cached idle capability check.
    const repair = await repairCapability(signal)
    signal.throwIfAborted()
    if (!repair.repairAvailable) throw invalid(repair.repairReason ?? '图片修补不可用', 503)
    const image = await repairImagePreview(grant.input, grant.media, strokes, tools.ffmpeg, signal)
    signal.throwIfAborted()
    if (await inputIdentity(grant.input, grant.kind) !== grant.identity) throw invalid('源图片在修补期间发生变化，请重新选择')
    if (this.grants.get(id) !== grant || grant.expires < Date.now()) throw invalid('图片授权已失效，请重新选择文件', 403)
    this.repairPreviews.set(id, createHash('sha256').update(JSON.stringify(strokes)).digest('hex'))
    return image
  }
  subscribe(fn: (event: UpscaleEvent) => void): () => void { this.listeners.add(fn); return () => this.listeners.delete(fn) }
  async authorize(input: string, directory: string, kind: UpscaleKind = 'video'): Promise<{ grant: string; kind: UpscaleKind; media: UpscaleMedia }> {
    if (this.closing) throw invalid('服务正在关闭', 503)
    if (this.blockedStorage) throw this.blockedStorage
    // Limit expensive preflight and grant accumulation independently of the task queue.
    for (const [key, g] of this.grants) if (g.expires < Date.now()) { this.grants.delete(key); this.repairPreviews.delete(key) }
    if (this.grants.size >= 20 || this.authorizing) throw invalid('请等待当前探测完成，或稍后重试', 429)
    this.authorizing = true
    const processes = new Processes(this.shutdown.signal)
    try {
      const identity = await inputIdentity(input, kind)
      const sourceStat = await stat(input)
      if (kind === 'image' && sourceStat.size > 100 * 1024 ** 2) throw invalid('图片文件不能超过 100 MB')
      await outputDirectory(directory)
      const { tools, capability } = await this.capabilities()
      if (!tools) throw invalid(capability.reason ?? '本地引擎不可用', 503)
      if (kind === 'image' && !capability.imageAvailable) throw invalid(capability.imageReason ?? '当前本地 FFmpeg 不支持图片超分，请更新超分依赖', 503)
      const media = kind === 'image'
        ? supportedImage(await inspectImage(input, tools, processes))
        : supportedMedia(await inspect(input, tools, processes))
      if (kind === 'video') await timeline(input, media, tools, processes)
      await checkSpace(directory, media, sourceStat.size)
      await checkAtomicOutput(directory)
      if (await inputIdentity(input, kind) !== identity) throw invalid('输入文件在探测期间发生变化')
      const grant = randomUUID()
      this.grants.set(grant, { input, directory, identity, kind, media, expires: Date.now() + 10 * 60_000 })
      return { grant, kind, media }
    } finally { await processes.settle(); this.authorizing = false }
  }
  private authorizing = false
  async create(request: UpscaleCreate): Promise<UpscaleTask> {
    await this.ready
    const parsed = upscaleCreateSchema.safeParse(request)
    if (!parsed.success) throw invalid(parsed.error.issues[0]?.message ?? '任务参数不合法')
    request = parsed.data
    if (this.closing) throw invalid('服务正在关闭', 503)
    if (this.blockedStorage) throw this.blockedStorage
    const g = this.grants.get(request.grant)
    if (!g || g.expires < Date.now()) throw invalid('文件授权已失效，请重新选择文件', 403)
    if ((request.kind ?? 'video') !== g.kind) throw invalid('输入类型与文件授权不一致，请重新选择文件', 403)
    if (request.repair) {
      const previewHash = this.repairPreviews.get(request.grant)
      const requestedHash = createHash('sha256').update(JSON.stringify(request.repair)).digest('hex')
      if (g.kind !== 'image' || !previewHash || previewHash !== requestedHash) throw invalid('修补选区与已确认的预览不一致，请重新生成预览', 409)
    }
    this.grants.delete(request.grant) // single-use, before any await
    this.repairPreviews.delete(request.grant)
    if ([...this.records.values()].filter((r) => ['queued', 'running'].includes(r.task.status)).length >= 10) throw invalid('超分队列已满', 429)
    if (await inputIdentity(g.input, g.kind) !== g.identity) throw invalid('输入文件已经变化，请重新选择')
    await outputDirectory(g.directory)
    const output = path.join(g.directory, request.fileName)
    if (output === g.input) throw invalid('输出不能是源文件')
    await this.unoccupied(output)
    if ([...this.records.values()].some((r) => r.task.output === output && ['queued', 'running'].includes(r.task.status))) throw invalid('输出路径已被队列占用', 409)
    // Recheck after filesystem awaits: concurrent creates must not overfill the queue.
    if (this.blockedStorage) throw this.blockedStorage
    if (this.closing) throw invalid('服务正在关闭', 503)
    if ([...this.records.values()].filter((r) => ['queued', 'running'].includes(r.task.status)).length >= 10) throw invalid('超分队列已满', 429)
    const now = Date.now()
    const task: UpscaleTask = { id: randomUUID(), input: g.input, output, kind: g.kind, model: 'realesr-animevideov3-x2', status: 'queued', stage: 'queued', completedFrames: 0, media: g.media, createdAt: now, updatedAt: now }
    const record: Record = { task, identity: g.identity, ...(request.repair ? { repair: request.repair } : {}) }
    this.records.set(task.id, record)
    try { this.save(record) } catch (error) { this.records.delete(task.id); this.dirty.delete(record); throw error }
    this.pump()
    return structuredClone(task)
  }
  cancel(id: string): UpscaleTask {
    const r = this.records.get(id)
    if (!r) throw invalid('超分任务不存在', 404)
    if (this.active?.id === id) {
      if (this.active.committing) throw invalid('输出正在原子提交，请等待结果', 409)
      this.active.abort.abort()
    } else if (r.task.status === 'queued') { r.task.status = 'cancelled'; this.safeSave(r) }
    return structuredClone(r.task)
  }
  async remove(id: string): Promise<void> {
    await this.ready
    const r = this.records.get(id)
    if (!r) throw invalid('超分任务不存在', 404)
    if (r.task.status === 'running') throw invalid('请先取消处理中的任务，再删除记录', 409)
    // Terminal status is published before finally{} completes. Never let late cleanup
    // save() resurrect a deleted record or race the no-overwrite output commit.
    if (this.active?.id === id) await this.active.promise
    if (this.records.get(id) !== r) throw invalid('超分任务不存在', 404)
    if (r.work) await this.cleanup(r)
    if (r.work) throw invalid('临时目录清理未完成，保留任务记录供检查，请稍后重试', 409)
    this.db.prepare('DELETE FROM upscale_tasks WHERE id=?').run(id)
    this.records.delete(id)
    this.dirty.delete(r)
    this.thumbnails.delete(id)
  }
  private pump(): void {
    if (this.active || this.preview || this.thumbnailBusy || this.closing || this.blockedStorage) return
    const r = [...this.records.values()].find((r) => r.task.status === 'queued')
    if (!r) return
    const abort = new AbortController()
    // Install active before the first async step, including cancellation during preflight.
    const state = { id: r.task.id, abort, committing: false, promise: Promise.resolve() }
    this.active = state
    state.promise = this.run(r, state).catch((error: unknown) => {
      // Last boundary for unexpected failures (including cleanup/event callbacks).
      if (r.task.status !== 'succeeded') {
        r.task.status = 'failed'
        r.task.error = { code: 'UPSCALE_FAILED', message: error instanceof Error ? error.message : String(error) }
      }
      this.safeSave(r)
    }).finally(() => { this.active = undefined; this.pump() })
  }
  private async run(r: Record, state: { abort: AbortController; committing: boolean }): Promise<void> {
    const processes = new Processes(state.abort.signal)
    try {
      r.task.status = 'running'; r.task.stage = 'probing'; this.save(r)
      // Rehash dependencies for every job: an idle capability cache is not a trust boundary.
      const { tools, capability: cap } = await capability(state.abort.signal)
      if (!tools) throw new Error(cap.reason ?? '缺少超分依赖')
      if (r.repair && !cap.repairAvailable) throw new Error(cap.repairReason ?? '图片修补不可用')
      if (await inputIdentity(r.task.input, r.task.kind ?? 'video') !== r.identity) throw new Error('源文件发生变化')
      await outputDirectory(path.dirname(r.task.output)); await this.unoccupied(r.task.output)
      await checkAtomicOutput(path.dirname(r.task.output))
      r.work = await mkdtemp(path.join(path.dirname(r.task.output), `.mediagrab-upscale-${r.task.id}-`))
      try { await writeFile(path.join(r.work, 'owner.json'), JSON.stringify({ id: r.task.id }), { flag: 'wx', mode: 0o600 }) }
      catch (error) { await rm(r.work, { recursive: true, force: true }); delete r.work; throw error }
      this.save(r)
      const runPipeline = r.task.kind === 'image' ? imagePipeline : pipeline
      const result = await runPipeline(r.task.input, r.work, tools, processes, (stage, completedFrames, media) => {
        Object.assign(r.task, { stage, completedFrames, ...(media ? { media } : {}) }); this.save(r)
      }, r.repair)
      if (await inputIdentity(r.task.input, r.task.kind ?? 'video') !== r.identity) throw new Error('源文件在处理期间发生变化，拒绝提交')
      await outputDirectory(path.dirname(r.task.output))
      state.abort.signal.throwIfAborted()
      // Commit linearization point: once here, cancel returns 409 instead of racing link().
      state.committing = true
      // Durable intent precedes publication: a crash between link() and save() is recoverable.
      r.pendingOutput = result; this.save(r)
      await link(result.path, r.task.output) // same-volume atomic, never overwrites a file/symlink
      r.task.result = { ...result, path: r.task.output }; r.task.status = 'succeeded'; r.task.stage = 'done'; this.save(r)
    } catch (e) {
      const cancelled = state.abort.signal.aborted
      if (!this.storageError && isStorageFull(e)) this.outputErrors.set(path.dirname(r.task.output), storageFailure(e))
      const storage = this.blockedStorage
      if (!r.task.result) {
        r.task.status = cancelled ? 'cancelled' : 'failed'
        r.task.error = { code: storage?.code ?? (cancelled ? 'CANCELLED' : 'UPSCALE_FAILED'), message: storage?.message ?? (cancelled ? '任务已取消' : e instanceof Error ? e.message : String(e)) }
      }
      // A successful hard-link commit is not undone/misreported if SQLite then fails.
      this.safeSave(r)
    } finally {
      state.abort.abort(); await processes.settle(); await this.cleanup(r)
    }
  }
  private async unoccupied(file: string): Promise<void> {
    try { await lstat(file) } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return; throw e }
    throw invalid('输出文件已存在，绝不覆盖', 409)
  }
  private async ownsWork(r: Record): Promise<boolean> {
    if (!r.work || path.dirname(r.work) !== path.dirname(r.task.output) || !path.basename(r.work).startsWith(`.mediagrab-upscale-${r.task.id}-`) || await realpath(r.work) !== r.work || !(await lstat(r.work)).isDirectory()) return false
    const ownerFile = path.join(r.work, 'owner.json'), info = await lstat(ownerFile)
    if (!info.isFile() || info.isSymbolicLink() || info.size > 1024) return false
    const owner = JSON.parse(await readFile(ownerFile, 'utf8')) as { id?: string }
    return owner.id === r.task.id
  }
  private async recoverOutput(r: Record): Promise<void> {
    const expectedCandidate = r.work && (r.task.kind === 'image'
      ? path.join(r.work, 'out', 'input.png')
      : path.join(r.work, 'candidate.mp4'))
    const expectedStage = r.task.kind === 'image' ? 'done' : 'validating'
    if (r.pendingOutput && r.task.status === 'interrupted' && r.task.stage === expectedStage
      && r.task.media && r.pendingOutput.path === expectedCandidate) {
      try {
        if (await this.ownsWork(r) && insideWork(r.work!, r.pendingOutput.path) && await realpath(r.pendingOutput.path) === r.pendingOutput.path) {
          const [candidate, output] = await Promise.all([lstat(r.pendingOutput.path), lstat(r.task.output)])
          // Same bytes alone are insufficient: only our published hard link is evidence.
          if (candidate.isFile() && output.isFile() && candidate.dev === output.dev && candidate.ino === output.ino && output.size === r.pendingOutput.bytes
            && await realpath(r.task.output) === r.task.output
            && await videoHash(r.task.output, AbortSignal.timeout(30_000)) === r.pendingOutput.sha256) {
            const { tools } = await capability(AbortSignal.timeout(30_000))
            if (!tools) throw new Error('Output validation tools are unavailable')
            const processes = new Processes(AbortSignal.timeout(30_000))
            try {
              if (r.task.kind === 'image') {
                const image = supportedImage(await inspectImage(r.task.output, tools, processes))
                if (image.width !== r.task.media.width * 2 || image.height !== r.task.media.height * 2) throw new Error('Recovered image dimensions mismatch')
              } else {
                const media = supportedMedia(await inspect(r.task.output, tools, processes, true))
                if (media.width !== r.task.media.width || media.height !== r.task.media.height || media.frames !== r.task.media.frames
                  || media.fps !== r.task.media.fps || media.audio !== r.task.media.audio || Math.abs(media.duration - r.task.media.duration) > 0.001) throw new Error('Recovered video metadata mismatch')
                await timeline(r.task.output, media, tools, processes, true)
              }
            } finally { await processes.settle() }
            r.task.result = { ...r.pendingOutput, path: r.task.output }
            r.task.status = 'succeeded'; r.task.stage = 'done'; delete r.task.error
          }
        }
      } catch { /* Missing, changed or inaccessible evidence is not proof of a successful commit. */ }
      this.safeSave(r)
    }
    await this.cleanup(r)
  }
  private async cleanup(r: Record): Promise<void> {
    if (!r.work || this.storageError) return
    try {
      if (!await this.ownsWork(r)) return
      await rm(r.work, { recursive: true }); delete r.work; delete r.pendingOutput; this.safeSave(r)
    } catch { /* Keep ownership evidence and directory for manual recovery; never delete unrelated files. */ }
  }
  private publish(r: Record): void {
    for (const fn of this.listeners) {
      try { fn({ type: 'upscale.updated', task: structuredClone(r.task) }) }
      catch { console.warn('[upscale] 任务事件订阅失败，已隔离订阅者异常') }
    }
  }
  private save(r: Record): void {
    r.task.updatedAt = Date.now()
    try {
      const snapshot = { ...r, task: { ...r.task, storageWarning: undefined } }
      this.db.prepare('INSERT INTO upscale_tasks(id,snapshot,created_at) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET snapshot=excluded.snapshot').run(r.task.id, JSON.stringify(snapshot), r.task.createdAt)
      this.dirty.delete(r)
      delete r.task.storageWarning
    } catch (error) {
      this.storageError = storageFailure(error)
      this.dirty.add(r)
      r.task.storageWarning = this.storageError.message
      throw this.storageError
    }
    this.publish(r)
  }
  private safeSave(r: Record): void {
    try { this.save(r) } catch {
      console.error('[upscale] 任务记录无法落盘，保留内存状态并暂停调度')
      this.publish(r)
    }
  }
  private recoverStorage(): Promise<void> {
    if (this.recovery) return this.recovery
    this.recovery = this.retryStorage().finally(() => { this.recovery = undefined })
    return this.recovery
  }
  private async retryStorage(): Promise<void> {
    await this.ready
    if (!this.blockedStorage || this.closing) return
    try {
      for (const r of this.dirty) this.save(r)
      // A failed initial INSERT leaves no accepted record to flush: probe SQLite too.
      this.db.exec('BEGIN IMMEDIATE; COMMIT;')
      this.storageError = undefined
      for (const directory of this.outputErrors.keys()) {
        await checkAtomicOutput(directory)
        const records = [...this.records.values()].filter((r) => path.dirname(r.task.output) === directory)
        const queued = records.filter((r) => r.task.status === 'queued')
        for (const r of queued.length ? queued : records.slice(-1)) {
          const sourceBytes = await stat(r.task.input).then((info) => info.size, () => 0)
          if (r.task.media) await checkSpace(directory, r.task.media, sourceBytes)
        }
        this.outputErrors.delete(directory)
      }
      for (const r of this.records.values()) if (r.work && this.active?.id !== r.task.id && !['queued', 'running'].includes(r.task.status)) await this.cleanup(r)
      this.pump()
    } catch {
      try { this.db.exec('ROLLBACK;') } catch { /* No transaction may be active. */ }
    }
  }
  async close(): Promise<void> {
    this.closing = true; this.shutdown.abort(); this.active?.abort.abort(); this.preview?.abort.abort()
    for (const r of this.records.values()) if (r.task.status === 'queued') { r.task.status = 'interrupted'; this.safeSave(r) }
    await Promise.allSettled([this.active?.promise, this.preview?.promise, this.ready, this.recovery, this.thumbnailTail])
    this.thumbnails.clear()
  }
}
