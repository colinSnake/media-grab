import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { access, lstat, realpath, stat, mkdtemp, writeFile, link, rm, readFile } from 'node:fs/promises'
import path from 'node:path'
import { upscaleCreateSchema, type RepairStrokes, type UpscaleCreate, type UpscaleEvent, type UpscaleKind, type UpscaleMedia, type UpscaleTask } from '@mediagrab/shared'
import type { Database } from '../store/db.js'
import { Processes } from './process.js'
import { capability } from './tools.js'
import { inspect, inspectImage, supportedImage, supportedMedia, timeline } from './probe.js'
import { checkSpace, pipeline } from './pipeline.js'
import { imagePipeline } from './image-pipeline.js'
import { checkAtomicOutput } from './output.js'
import { upscaleRecordSchema } from './record.js'
import { firstFrame } from './thumbnail.js'
import { repairImagePreview } from './inpainting.js'

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
interface Grant { input: string; directory: string; identity: string; kind: UpscaleKind; media: UpscaleMedia; expires: number }
interface Record { task: UpscaleTask; identity: string; repair?: RepairStrokes; work?: string }
export class UpscaleService {
  private records = new Map<string, Record>()
  private grants = new Map<string, Grant>()
  private repairPreviews = new Map<string, string>()
  private repairPreviewBusy = false
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
        this.save(record)
      }
      // A crash after saving a terminal state but before finally{} must not leak frames.
      if (record.work) recovered.push(record)
    }
    this.ready = Promise.all(recovered.map((r) => this.cleanup(r))).then(() => {})
  }
  capabilities(): ReturnType<typeof capability> {
    // Never load the inference model when idle. A failed dependency check can be retried.
    this.capabilityPromise ??= capability(this.shutdown.signal).then((result) => { if (!result.tools) this.capabilityPromise = undefined; return result })
    return this.capabilityPromise
  }
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
        while (this.active) await this.active.promise
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
    return firstFrame(tools.ffmpeg, grant.input, this.shutdown.signal, 'image')
  }
  async repairPreview(id: string, strokes: RepairStrokes): Promise<Buffer> {
    if (this.repairPreviewBusy) throw invalid('已有修补预览正在生成，请稍后重试', 429)
    this.repairPreviewBusy = true
    try {
    const grant = this.grants.get(id)
    if (!grant || grant.expires < Date.now() || grant.kind !== 'image') throw invalid('图片授权已失效，请重新选择文件', 403)
    if (await inputIdentity(grant.input, grant.kind) !== grant.identity) throw invalid('源图片发生变化，请重新选择')
    const { tools } = await this.capabilities()
    if (!tools) throw invalid('本地图片处理依赖不可用', 503)
    const image = await repairImagePreview(grant.input, grant.media, strokes, tools.ffmpeg, this.shutdown.signal)
    this.repairPreviews.set(id, createHash('sha256').update(JSON.stringify(strokes)).digest('hex'))
    return image
    } finally { this.repairPreviewBusy = false }
  }
  subscribe(fn: (event: UpscaleEvent) => void): () => void { this.listeners.add(fn); return () => this.listeners.delete(fn) }
  async authorize(input: string, directory: string, kind: UpscaleKind = 'video'): Promise<{ grant: string; kind: UpscaleKind; media: UpscaleMedia }> {
    if (this.closing) throw invalid('服务正在关闭', 503)
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
    if (this.closing) throw invalid('服务正在关闭', 503)
    if ([...this.records.values()].filter((r) => ['queued', 'running'].includes(r.task.status)).length >= 10) throw invalid('超分队列已满', 429)
    const now = Date.now()
    const task: UpscaleTask = { id: randomUUID(), input: g.input, output, kind: g.kind, model: 'realesr-animevideov3-x2', status: 'queued', stage: 'queued', completedFrames: 0, media: g.media, createdAt: now, updatedAt: now }
    const record: Record = { task, identity: g.identity, ...(request.repair ? { repair: request.repair } : {}) }
    this.records.set(task.id, record); this.save(record); this.pump()
    return structuredClone(task)
  }
  cancel(id: string): UpscaleTask {
    const r = this.records.get(id)
    if (!r) throw invalid('超分任务不存在', 404)
    if (this.active?.id === id) {
      if (this.active.committing) throw invalid('输出正在原子提交，请等待结果', 409)
      this.active.abort.abort()
    } else if (r.task.status === 'queued') { r.task.status = 'cancelled'; this.save(r) }
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
    this.thumbnails.delete(id)
  }
  private pump(): void {
    if (this.active || this.thumbnailBusy || this.closing) return
    const r = [...this.records.values()].find((r) => r.task.status === 'queued')
    if (!r) return
    const abort = new AbortController()
    // Install active before the first async step, including cancellation during preflight.
    const state = { id: r.task.id, abort, committing: false, promise: Promise.resolve() }
    this.active = state
    state.promise = this.run(r, state).finally(() => { this.active = undefined; this.pump() })
  }
  private async run(r: Record, state: { abort: AbortController; committing: boolean }): Promise<void> {
    const processes = new Processes(state.abort.signal)
    try {
      r.task.status = 'running'; r.task.stage = 'probing'; this.save(r)
      // Rehash dependencies for every job: an idle capability cache is not a trust boundary.
      const { tools, capability: cap } = await capability(state.abort.signal)
      if (!tools) throw new Error(cap.reason ?? '缺少超分依赖')
      if (await inputIdentity(r.task.input, r.task.kind ?? 'video') !== r.identity) throw new Error('源文件发生变化')
      await outputDirectory(path.dirname(r.task.output)); await this.unoccupied(r.task.output)
      await checkAtomicOutput(path.dirname(r.task.output))
      r.work = await mkdtemp(path.join(path.dirname(r.task.output), `.mediagrab-upscale-${r.task.id}-`))
      await writeFile(path.join(r.work, 'owner.json'), JSON.stringify({ id: r.task.id }), { flag: 'wx', mode: 0o600 }); this.save(r)
      const runPipeline = r.task.kind === 'image' ? imagePipeline : pipeline
      const result = await runPipeline(r.task.input, r.work, tools, processes, (stage, completedFrames, media) => {
        Object.assign(r.task, { stage, completedFrames, ...(media ? { media } : {}) }); this.save(r)
      }, r.repair)
      if (await inputIdentity(r.task.input, r.task.kind ?? 'video') !== r.identity) throw new Error('源文件在处理期间发生变化，拒绝提交')
      await outputDirectory(path.dirname(r.task.output))
      state.abort.signal.throwIfAborted()
      // Commit linearization point: once here, cancel returns 409 instead of racing link().
      state.committing = true
      await link(result.path, r.task.output) // same-volume atomic, never overwrites a file/symlink
      r.task.result = { ...result, path: r.task.output }; r.task.status = 'succeeded'; r.task.stage = 'done'; this.save(r)
    } catch (e) {
      const cancelled = state.abort.signal.aborted
      r.task.status = cancelled ? 'cancelled' : 'failed'
      r.task.error = { code: cancelled ? 'CANCELLED' : 'UPSCALE_FAILED', message: cancelled ? '任务已取消' : e instanceof Error ? e.message : String(e) }; this.save(r)
    } finally {
      state.abort.abort(); await processes.settle(); await this.cleanup(r)
    }
  }
  private async unoccupied(file: string): Promise<void> {
    try { await lstat(file) } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return; throw e }
    throw invalid('输出文件已存在，绝不覆盖', 409)
  }
  private async cleanup(r: Record): Promise<void> {
    if (!r.work) return
    try {
      if (path.dirname(r.work) !== path.dirname(r.task.output) || !path.basename(r.work).startsWith(`.mediagrab-upscale-${r.task.id}-`) || await realpath(r.work) !== r.work || !(await lstat(r.work)).isDirectory()) return
      const owner = JSON.parse(await readFile(path.join(r.work, 'owner.json'), 'utf8')) as { id?: string }
      if (owner.id !== r.task.id) return
      await rm(r.work, { recursive: true }); delete r.work; this.save(r)
    } catch { /* Keep ownership evidence and directory for manual recovery; never delete unrelated files. */ }
  }
  private save(r: Record): void {
    r.task.updatedAt = Date.now()
    this.db.prepare('INSERT INTO upscale_tasks(id,snapshot,created_at) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET snapshot=excluded.snapshot').run(r.task.id, JSON.stringify(r), r.task.createdAt)
    for (const fn of this.listeners) fn({ type: 'upscale.updated', task: structuredClone(r.task) })
  }
  async close(): Promise<void> {
    this.closing = true; this.shutdown.abort(); this.active?.abort.abort()
    for (const r of this.records.values()) if (r.task.status === 'queued') { r.task.status = 'interrupted'; this.save(r) }
    await this.active?.promise; await this.ready; await this.thumbnailTail
    this.thumbnails.clear()
  }
}
