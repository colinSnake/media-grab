import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, realpath, rm, stat, lstat, writeFile, mkdir, readdir, link, symlink } from 'node:fs/promises'
import os from 'node:os'
import { randomUUID, createHash } from 'node:crypto'
import path from 'node:path'
import { Database } from '../store/db.js'
import type { UpscaleTask } from '@mediagrab/shared'

const control = vi.hoisted(() => ({ repair: true, mode: 'success', fullOutputProbe: false, inFlight: 0, peak: 0, blockCommit: false, unsupportedLinks: false, releaseCommit: undefined as undefined | (() => void), beforeLink: undefined as undefined | (() => void) }))
vi.mock('./tools.js', async (original) => ({ ...await original<typeof import('./tools.js')>(), capability: vi.fn(async () => ({ capability: { available: true, imageAvailable: true, repairAvailable: control.repair, repairReason: control.repair ? undefined : '未安装图片修补模型' }, tools: { ffmpeg: 'fixture', ffprobe: 'fixture', engine: 'fixture', models: 'fixture' } })) }))
vi.mock('./probe.js', async (original) => ({ ...await original<typeof import('./probe.js')>(), inspect: vi.fn(async () => ({})), inspectImage: vi.fn(async () => ({})), timeline: vi.fn(async () => {}), supportedMedia: vi.fn(() => ({ width: 128, height: 72, fps: '24/1', frames: 26, duration: 26 / 24, audio: false })), supportedImage: vi.fn(() => ({ width: 800, height: 600, fps: '1/1', frames: 1, duration: 1, audio: false })) }))

vi.mock('./image-pipeline.js', () => ({ imagePipeline: vi.fn(async (_input: string, work: string, _tools: unknown, _processes: unknown, update: (stage: string, completed: number) => void) => {
  const file = path.join(work, 'candidate.png'); await writeFile(file, 'unit fixture, not real image upscale')
  update('validating', 1)
  return { path: file, bytes: Buffer.byteLength('unit fixture, not real image upscale'), sha256: createHash('sha256').update('unit fixture, not real image upscale').digest('hex') }
}) }))

vi.mock('./pipeline.js', async (original) => ({ ...await original<typeof import('./pipeline.js')>(), pipeline: vi.fn(async (_input, work, _tools, processes, update) => {
  control.peak = Math.max(control.peak, ++control.inFlight)
  try {
    update('upscaling', 0)
    if (control.mode === 'wait') await new Promise<void>((_resolve, reject) => { processes.signal.addEventListener('abort', () => reject(new DOMException('This operation was aborted', 'AbortError')), { once: true }); if (processes.signal.aborted) reject(new DOMException('This operation was aborted', 'AbortError')) })
    if (control.mode === 'fail') throw new Error('controlled engine failure')
    if (control.mode === 'message-full') throw new Error('ffmpeg failed: No space left on device')
    if (control.mode === 'quota') throw new Error('output failed', { cause: Object.assign(new Error('Disk quota exceeded'), { code: 'EDQUOT' }) })
    if (control.mode === 'enospc') throw Object.assign(new Error('No space left on device'), { code: 'ENOSPC' })
    const file = path.join(work, 'candidate.mp4'); await writeFile(file, 'unit fixture, not real upscale')
    update('validating', 26)
    return { path: file, bytes: Buffer.byteLength('unit fixture, not real upscale'), sha256: createHash('sha256').update('unit fixture, not real upscale').digest('hex') }
  } finally { control.inFlight-- }
}) }))
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>()
  return { ...actual, link: async (src: string, dest: string) => {
    if (control.fullOutputProbe && path.basename(src) === 'source') throw new Error('No space left on device')
    if (control.unsupportedLinks) throw Object.assign(new Error('No hardlinks'), { code: 'ENOTSUP' })
    if (control.blockCommit && path.basename(src) === 'candidate.mp4') { control.beforeLink?.(); await new Promise<void>((resolve) => { control.releaseCommit = resolve }) }
    return actual.link(src, dest)
  } }
})
vi.mock('./thumbnail.js', () => ({ firstFrame: vi.fn(async () => Buffer.from('89504e470d0a1a0a', 'hex')) }))
vi.mock('./repair-capability.js', () => ({ repairCapability: vi.fn(async () => ({ repairAvailable: control.repair, repairReason: control.repair ? undefined : '未安装图片修补模型' })) }))
vi.mock('./inpainting.js', () => ({ repairImagePreview: vi.fn(async () => Buffer.from('PNG')) }))
import { firstFrame } from './thumbnail.js'
import { repairImagePreview } from './inpainting.js'
import { UpscaleService } from './service.js'
import { Processes } from './process.js'
let root: string, db: Database, service: UpscaleService, input: string
beforeEach(async () => {
  vi.mocked(firstFrame).mockClear()
  vi.mocked(repairImagePreview).mockReset().mockResolvedValue(Buffer.from('PNG'))
  Object.assign(control, { repair: true, mode: 'success', fullOutputProbe: false, inFlight: 0, peak: 0, blockCommit: false, unsupportedLinks: false, releaseCommit: undefined, beforeLink: undefined })
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'upscale-lifecycle-')))
  input = path.join(root, 'input.mp4'); await writeFile(input, 'original')
  db = Database.open(':memory:'); service = new UpscaleService(db)
})
afterEach(async () => { vi.restoreAllMocks(); control.releaseCommit?.(); await service.close(); db.close(); await rm(root, { recursive: true, force: true }) })
const grant = () => service.authorize(input, root)
async function terminal(id: string): Promise<UpscaleTask> {
  for (let i = 0; i < 500; i++) { const t = service.get(id); if (!['queued', 'running'].includes(t.status)) { await new Promise((r) => setTimeout(r, 5)); return t }; await new Promise((r) => setTimeout(r, 2)) }
  throw new Error('unit job timed out')
}
describe('single-image upscale task lifecycle', () => {
  it('authorizes a native-selected PNG, queues a PNG result and keeps its type in task history', async () => {
    const image = path.join(root, 'portrait.png')
    await writeFile(image, 'fixture source image')
    const identity = await import('./service.js').then(({ inputIdentity }) => inputIdentity(image, 'image'))
    const g = await service.authorize(image, root, 'image')
    expect(g).toMatchObject({ kind: 'image', media: { width: 800, height: 600, frames: 1 } })
    const task = await service.create({ grant: g.grant, kind: 'image', fileName: 'portrait-2x' })
    expect(task).toMatchObject({ kind: 'image', output: path.join(root, 'portrait-2x.png') })
    expect((await terminal(task.id)).status).toBe('succeeded')
    expect(service.get(task.id)).toMatchObject({ kind: 'image', completedFrames: 1 })
    expect(await readFile(image, 'utf8')).toBe('fixture source image')
    expect(identity).toEqual(expect.any(String))
  })
  it('rejects a video/image mode mismatch against its one-use grant', async () => {
    const image = path.join(root, 'mismatch.jpg')
    await writeFile(image, 'fixture source image')
    const g = await service.authorize(image, root, 'image')
    await expect(service.create({ grant: g.grant, kind: 'video', fileName: 'wrong.mp4' })).rejects.toThrow('不一致')
    await expect(service.create({ grant: g.grant, kind: 'image', fileName: 'right' })).resolves.toMatchObject({ kind: 'image', output: path.join(root, 'right.png') })
  })
  it('requires the exact image repair selection to have a generated preview before queuing', async () => {
    const image = path.join(root, 'repair.png')
    await writeFile(image, 'fixture source image')
    const g = await service.authorize(image, root, 'image')
    const strokes = [{ radius: 0.02, points: [{ x: 0.2, y: 0.3 }] }]
    await expect(service.create({ grant: g.grant, kind: 'image', fileName: 'fixed.png', repair: strokes })).rejects.toThrow('预览')
    await service.repairPreview(g.grant, strokes)
    expect(repairImagePreview).toHaveBeenCalledWith(image, expect.anything(), strokes, 'fixture', expect.anything())
    const changed = [{ radius: 0.02, points: [{ x: 0.8, y: 0.3 }] }]
    await expect(service.create({ grant: g.grant, kind: 'image', fileName: 'fixed.png', repair: changed })).rejects.toThrow('不一致')
    await expect(service.create({ grant: g.grant, kind: 'image', fileName: 'fixed.png', repair: strokes })).resolves.toMatchObject({ kind: 'image' })
  })
})

describe('isolated upscale task lifecycle (mocked inference, not quality evidence)', () => {
  it('consumes grants once and refuses arbitrary/ungranted paths', async () => {
    const g = await grant(); const task = await service.create({ grant: g.grant, fileName: 'new.mp4' })
    await expect(service.create({ grant: g.grant, fileName: 'second.mp4' })).rejects.toThrow('授权')
    expect((await terminal(task.id)).status).toBe('succeeded'); expect(await readFile(input, 'utf8')).toBe('original')
  })
  it('detects source changes after authorization', async () => {
    const g = await grant(); await writeFile(input, 'replaced source'); await expect(service.create({ grant: g.grant, fileName: 'new.mp4' })).rejects.toThrow('变化')
  })
  it('uses the normalized MP4 name and preserves the grant on filename validation errors', async () => {
    const g = await grant()
    await expect(service.create({ grant: g.grant, fileName: '../out' })).rejects.toThrow('目录')
    const task = await service.create({ grant: g.grant, fileName: '  难却-2x  ' })
    expect(task.output).toBe(path.join(root, '难却-2x.mp4'))
    expect((await terminal(task.id)).status).toBe('succeeded')
  })
  it('never overwrites an existing output or the source', async () => {
    const g = await grant(); await expect(service.create({ grant: g.grant, fileName: 'input.mp4' })).rejects.toThrow('源文件')
    const h = await grant(); await writeFile(path.join(root, 'taken.mp4'), 'existing'); await expect(service.create({ grant: h.grant, fileName: 'taken.mp4' })).rejects.toThrow('已存在')
    const normalizedSource = await grant(); await expect(service.create({ grant: normalizedSource.grant, fileName: ' input ' })).rejects.toThrow('源文件')
    const normalizedExisting = await grant(); await expect(service.create({ grant: normalizedExisting.grant, fileName: ' taken ' })).rejects.toThrow('已存在')
  })
  it('queues separately, allows only one inference, and cancels queued/running jobs', async () => {
    control.mode = 'wait'
    const g = await grant(); const a = await service.create({ grant: g.grant, fileName: 'a.mp4' })
    const h = await grant(); const b = await service.create({ grant: h.grant, fileName: 'b.mp4' })
    expect(b.status).toBe('queued'); expect(service.cancel(b.id).status).toBe('cancelled'); service.cancel(a.id)
    const cancelled = await terminal(a.id)
    expect(cancelled.status).toBe('cancelled'); expect(cancelled.error).toEqual({ code: 'CANCELLED', message: '任务已取消' }); expect(control.peak).toBeLessThanOrEqual(1)
    await expect(stat(a.output)).rejects.toThrow(); await expect(stat(b.output)).rejects.toThrow()
  })
  it('keeps a preexisting file created at the atomic commit race', async () => {
    control.blockCommit = true
    control.beforeLink = () => { void writeFile(path.join(root, 'race.mp4'), 'other writer').then(() => control.releaseCommit?.()) }
    const g = await grant(); const t = await service.create({ grant: g.grant, fileName: 'race.mp4' })
    expect((await terminal(t.id)).status).toBe('failed'); expect(await readFile(t.output, 'utf8')).toBe('other writer')
  })
  it('rejects cancellation after the commit linearization point', async () => {
    control.blockCommit = true
    let reached!: () => void; const ready = new Promise<void>((resolve) => { reached = resolve }); control.beforeLink = reached
    const g = await grant(); const t = await service.create({ grant: g.grant, fileName: 'commit.mp4' }); await ready
    expect(() => service.cancel(t.id)).toThrow('提交'); control.releaseCommit?.(); expect((await terminal(t.id)).status).toBe('succeeded')
  })
  it('cleans only owned work directories on failure', async () => {
    control.mode = 'fail'; const foreign = path.join(root, 'unrelated'); await mkdir(foreign); await writeFile(path.join(foreign, 'keep'), 'keep')
    const g = await grant(); const t = await service.create({ grant: g.grant, fileName: 'failed.mp4' })
    const done = await terminal(t.id); expect(done.status).toBe('failed'); expect(done.error?.message).toContain('controlled engine failure')
    expect(await readFile(path.join(foreign, 'keep'), 'utf8')).toBe('keep')
    await service.close() // terminal task status is visible before its async cleanup finishes
    const row = db.prepare('SELECT snapshot FROM upscale_tasks WHERE id=?').get(t.id)!; expect(JSON.parse(String(row.snapshot)).work).toBeUndefined()
  })
  it('interrupts leftover running jobs and cleans only directories with matching ownership', async () => {
    await service.close()
    const ownedId = randomUUID(), foreignId = randomUUID()
    for (const [id, owned] of [[ownedId, true], [foreignId, false]] as const) {
      const work = path.join(root, `.mediagrab-upscale-${id}-test`); await mkdir(work); await writeFile(path.join(work, 'owner.json'), JSON.stringify({ id: owned ? id : 'someone-else' }))
      const task = { id, input, output: path.join(root, `${id}.mp4`), status: 'running', stage: 'encoding', createdAt: 1, updatedAt: 1, completedFrames: 12, model: 'realesr-animevideov3-x2' }
      db.prepare('INSERT INTO upscale_tasks VALUES(?,?,?)').run(id, JSON.stringify({ task, work, identity: 'old' }), 1)
    }
    service = new UpscaleService(db); expect(service.get(ownedId).status).toBe('interrupted'); await service.close()
    await expect(stat(path.join(root, `.mediagrab-upscale-${ownedId}-test`))).rejects.toThrow()
    expect((await stat(path.join(root, `.mediagrab-upscale-${foreignId}-test`))).isDirectory()).toBe(true)
  })
})


it('rejects filesystems without hardlinks before inference and cleans its check files', async () => {
  control.unsupportedLinks = true
  await expect(grant()).rejects.toThrow('硬链接')
  expect(control.peak).toBe(0)
  const { readdir } = await import('node:fs/promises')
  expect((await readdir(root)).filter((name) => name.startsWith('.mediagrab-upscale-'))).toEqual([])
})
it('enforces filename validation even for direct service callers', async () => {
  const g = await grant()
  await expect(service.create({ grant: g.grant, fileName: '../escape.mp4' })).rejects.toThrow('目录')
  await expect(service.create({ grant: g.grant, fileName: '中'.repeat(100) + '.mp4' })).rejects.toThrow('过长')
  expect(control.peak).toBe(0)
})
it('does not overfill the queue during simultaneous create requests', async () => {
  control.mode = 'wait'
  const grants = []
  for (let i = 0; i < 12; i++) grants.push(await grant())
  const results = await Promise.allSettled(grants.map((g, i) => service.create({ grant: g.grant, fileName: `queued-${i}.mp4` })))
  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(10)
  expect(service.list().filter((t) => ['queued', 'running'].includes(t.status))).toHaveLength(10)
  expect(control.peak).toBeLessThanOrEqual(1)
})
it('preserves invalid database rows without letting one crash the desktop core', async () => {
  await service.close()
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  try {
    for (const [id, snapshot] of [['broken-json', '{'], ['wrong-shape', JSON.stringify({ task: { id: 'escape/../' }, work: root })]] as const) {
      db.prepare('INSERT INTO upscale_tasks VALUES(?,?,?)').run(id, snapshot, 1)
    }
    service = new UpscaleService(db)
    expect(service.list()).toEqual([])
    expect(warn).toHaveBeenCalledTimes(2)
    expect(db.prepare('SELECT id FROM upscale_tasks').all()).toHaveLength(2)
    expect((await stat(input)).isFile()).toBe(true)
  } finally { warn.mockRestore() }
})
it('cleans terminal-state work after a crash without deleting the published result', async () => {
  await service.close()
  const id = randomUUID(), output = path.join(root, 'published.mp4')
  const work = path.join(root, `.mediagrab-upscale-${id}-crash`)
  await mkdir(work); await writeFile(path.join(work, 'owner.json'), JSON.stringify({ id }))
  await writeFile(path.join(work, 'candidate.mp4'), 'candidate'); await writeFile(output, 'published')
  const task = { id, input, output, model: 'realesr-animevideov3-x2', status: 'succeeded', stage: 'done', completedFrames: 26, createdAt: 1, updatedAt: 1, result: { path: output, bytes: 9, sha256: 'a'.repeat(64) } }
  db.prepare('INSERT INTO upscale_tasks VALUES(?,?,?)').run(id, JSON.stringify({ task, work, identity: 'old' }), 1)
  service = new UpscaleService(db); await service.close()
  expect(service.get(id).status).toBe('succeeded')
  await expect(stat(work)).rejects.toThrow()
  expect(await readFile(output, 'utf8')).toBe('published')
})

describe('deleting upscale task records without deleting source or output', () => {
  it('deletes succeeded history durably but keeps the published video and source', async () => {
    const g = await grant(), task = await service.create({ grant: g.grant, fileName: 'keep-result.mp4' })
    expect((await terminal(task.id)).status).toBe('succeeded')
    await service.remove(task.id)
    expect(service.list()).toEqual([])
    expect(() => service.get(task.id)).toThrow('不存在')
    expect(db.prepare('SELECT id FROM upscale_tasks WHERE id=?').get(task.id)).toBeUndefined()
    expect(await readFile(input, 'utf8')).toBe('original')
    expect(await readFile(task.output, 'utf8')).toBe('unit fixture, not real upscale')
    await service.close(); service = new UpscaleService(db)
    expect(service.list()).toEqual([])
  })
  it('deletes failed and cancelled records after awaiting their pending cleanup', async () => {
    for (const mode of ['fail', 'wait']) {
      control.mode = mode
      const g = await grant(), task = await service.create({ grant: g.grant, fileName: `${mode}.mp4` })
      if (mode === 'wait') service.cancel(task.id)
      // Poll without terminal()'s extra delay: removal must handle the cleanup race.
      while (['queued', 'running'].includes(service.get(task.id).status)) await new Promise((resolve) => setTimeout(resolve, 1))
      await service.remove(task.id)
      expect(db.prepare('SELECT id FROM upscale_tasks WHERE id=?').get(task.id)).toBeUndefined()
    }
    const { readdir } = await import('node:fs/promises')
    expect((await readdir(root)).filter((name) => name.startsWith('.mediagrab-upscale-'))).toEqual([])
    expect(await readFile(input, 'utf8')).toBe('original')
  })
  it('removes queued tasks but refuses a running task until cancelled', async () => {
    control.mode = 'wait'
    const a = await grant(), b = await grant()
    const running = await service.create({ grant: a.grant, fileName: 'running.mp4' })
    const queued = await service.create({ grant: b.grant, fileName: 'queued.mp4' })
    expect(service.get(queued.id).status).toBe('queued')
    await expect(service.remove(running.id)).rejects.toMatchObject({ statusCode: 409 })
    await service.remove(queued.id)
    expect(service.list().map((task) => task.id)).toEqual([running.id])
    service.cancel(running.id); await terminal(running.id); await service.remove(running.id)
    await expect(service.remove(queued.id)).rejects.toMatchObject({ statusCode: 404 })
  })
  it('refuses deletion during the atomic output commit', async () => {
    control.blockCommit = true
    let signalCommit!: () => void
    const atCommit = new Promise<void>((resolve) => { signalCommit = resolve }); control.beforeLink = signalCommit
    const g = await grant(), task = await service.create({ grant: g.grant, fileName: 'commit-delete.mp4' })
    await atCommit
    await expect(service.remove(task.id)).rejects.toMatchObject({ statusCode: 409 })
    control.releaseCommit?.(); await terminal(task.id); await service.remove(task.id)
    expect(await readFile(task.output, 'utf8')).toBe('unit fixture, not real upscale')
  })
  it('retains ownership evidence if an unsafe work directory cannot be cleaned', async () => {
    await service.close()
    const id = randomUUID(), work = path.join(root, `.mediagrab-upscale-${id}-foreign`)
    await mkdir(work); await writeFile(path.join(work, 'owner.json'), JSON.stringify({ id: 'not-ours' }))
    const task = { id, input, output: path.join(root, 'interrupted.mp4'), model: 'realesr-animevideov3-x2', status: 'interrupted', stage: 'encoding', completedFrames: 1, createdAt: 1, updatedAt: 1 }
    db.prepare('INSERT INTO upscale_tasks VALUES(?,?,?)').run(id, JSON.stringify({ task, work, identity: 'old' }), 1)
    service = new UpscaleService(db)
    await expect(service.remove(id)).rejects.toMatchObject({ statusCode: 409 })
    expect((await stat(work)).isDirectory()).toBe(true)
    expect(service.get(id).status).toBe('interrupted')
  })
  it('deletes recovered interrupted records after owned startup cleanup', async () => {
    await service.close()
    const id = randomUUID(), work = path.join(root, `.mediagrab-upscale-${id}-owned`)
    await mkdir(work); await writeFile(path.join(work, 'owner.json'), JSON.stringify({ id }))
    const task = { id, input, output: path.join(root, 'old.mp4'), model: 'realesr-animevideov3-x2', status: 'running', stage: 'encoding', completedFrames: 1, createdAt: 1, updatedAt: 1 }
    db.prepare('INSERT INTO upscale_tasks VALUES(?,?,?)').run(id, JSON.stringify({ task, work, identity: 'old' }), 1)
    service = new UpscaleService(db); await service.remove(id)
    expect(service.list()).toEqual([]); await expect(stat(work)).rejects.toThrow()
    expect(await readFile(input, 'utf8')).toBe('original')
  })
})


describe('task-bound first-frame thumbnails', () => {
  const finished = async () => { const g = await grant(); const task = await service.create({ grant: g.grant, fileName: 'cover.mp4' }); await terminal(task.id); return task }
  it('only decodes recorded source paths and reuses cached frames without touching output files', async () => {
    const task = await finished()
    const before = await stat(input)
    expect(await service.thumbnail(task.id)).toEqual(Buffer.from('89504e470d0a1a0a', 'hex'))
    await service.thumbnail(task.id)
    expect(firstFrame).toHaveBeenCalledTimes(1)
    expect(vi.mocked(firstFrame).mock.calls[0]?.slice(0, 2)).toEqual(['fixture', input])
    expect((await stat(input)).mtimeMs).toBe(before.mtimeMs)
    await expect(service.thumbnail(randomUUID())).rejects.toThrow('不存在')
  })
  it('refuses cached covers once the authorized source changes and clears deleted task covers', async () => {
    const task = await finished()
    await service.thumbnail(task.id)
    await writeFile(input, 'changed')
    await expect(service.thumbnail(task.id)).rejects.toThrow('变化')
    expect(firstFrame).toHaveBeenCalledTimes(1)
    await service.remove(task.id)
    await expect(service.thumbnail(task.id)).rejects.toThrow('不存在')
  })
  it('deduplicates concurrent requests and does not retain failed decodes', async () => {
    const task = await finished()
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    vi.mocked(firstFrame).mockImplementationOnce(async () => { await gate; throw new Error('fixture cover failure') })
    const results = Promise.allSettled([service.thumbnail(task.id), service.thumbnail(task.id)])
    for (let i = 0; i < 30 && !vi.mocked(firstFrame).mock.calls.length; i++) await new Promise((resolve) => setTimeout(resolve, 2))
    release()
    expect((await results).map((result) => result.status)).toEqual(['rejected', 'rejected'])
    expect(firstFrame).toHaveBeenCalledTimes(1)
    await service.thumbnail(task.id)
    expect(firstFrame).toHaveBeenCalledTimes(2)
  })
})


it('rejects a source replaced while its first frame is being decoded', async () => {
  const g = await grant(), task = await service.create({ grant: g.grant, fileName: 'cover-race.mp4' }); await terminal(task.id)
  vi.mocked(firstFrame).mockImplementationOnce(async () => { await writeFile(input, 'replaced during thumbnail'); return Buffer.from('89504e470d0a1a0a', 'hex') })
  await expect(service.thumbnail(task.id)).rejects.toThrow('变化')
})
it('does not retain or return an in-flight cover after deleting its task', async () => {
  const g = await grant(), task = await service.create({ grant: g.grant, fileName: 'cover-delete.mp4' }); await terminal(task.id)
  vi.mocked(firstFrame).mockImplementationOnce(async () => { await service.remove(task.id); return Buffer.from('89504e470d0a1a0a', 'hex') })
  await expect(service.thumbnail(task.id)).rejects.toThrow('不存在')
  expect(service.list()).toEqual([])
})

it('serializes cover decoding behind active inference to avoid competing with upscale', async () => {
  control.mode = 'wait'
  const g = await grant(), task = await service.create({ grant: g.grant, fileName: 'cover-after-job.mp4' })
  for (let i = 0; i < 50 && service.get(task.id).status !== 'running'; i++) await new Promise((resolve) => setTimeout(resolve, 2))
  const cover = service.thumbnail(task.id)
  await new Promise((resolve) => setTimeout(resolve, 20))
  expect(firstFrame).not.toHaveBeenCalled()
  service.cancel(task.id)
  expect((await terminal(task.id)).status).toBe('cancelled')
  expect(await cover).toEqual(Buffer.from('89504e470d0a1a0a', 'hex'))
  expect(firstFrame).toHaveBeenCalledTimes(1)
})

describe('repair preview resource ownership', () => {
  const strokes = [{ radius: 0.04, points: [{ x: 0.5, y: 0.5 }] }]
  async function imageGrant() {
    const image = path.join(root, 'preview.png'); await writeFile(image, 'image fixture')
    return service.authorize(image, root, 'image')
  }
  it('rejects a preview while an upscale task owns the resource slot', async () => {
    const g = await imageGrant(), video = await grant()
    control.mode = 'wait'
    const task = await service.create({ grant: video.grant, fileName: 'busy.mp4' })
    await expect.poll(() => control.inFlight).toBe(1)
    await expect(service.repairPreview(g.grant, strokes)).rejects.toMatchObject({ statusCode: 429 })
    expect(repairImagePreview).not.toHaveBeenCalled()
    service.cancel(task.id); await terminal(task.id)
  })
  it('queues but does not start a task during a preview; cancellation releases the slot', async () => {
    const g = await imageGrant(), abort = new AbortController()
    vi.mocked(repairImagePreview).mockImplementationOnce(async (_input, _media, _strokes, _ffmpeg, signal) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('任务已取消')), { once: true })
    }))
    const preview = service.repairPreview(g.grant, strokes, abort.signal)
    const rejected = expect(preview).rejects.toThrow('任务已取消')
    await expect.poll(() => vi.mocked(repairImagePreview).mock.calls.length).toBe(1)
    const video = await grant(), task = await service.create({ grant: video.grant, fileName: 'after-preview.mp4' })
    expect(service.get(task.id).status).toBe('queued'); expect(control.inFlight).toBe(0)
    await expect(service.repairPreview(g.grant, strokes)).rejects.toMatchObject({ statusCode: 429 })
    abort.abort(); await rejected
    expect((await terminal(task.id)).status).toBe('succeeded')
  })
  it('waits for preview cancellation cleanup when closing the service', async () => {
    const g = await imageGrant(); let cleaned = false
    vi.mocked(repairImagePreview).mockImplementationOnce(async (_input, _media, _strokes, _ffmpeg, signal) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => { setTimeout(() => { cleaned = true; reject(new Error('任务已取消')) }, 5) }, { once: true })
    }))
    const preview = service.repairPreview(g.grant, strokes)
    const rejected = expect(preview).rejects.toThrow('任务已取消')
    await expect.poll(() => vi.mocked(repairImagePreview).mock.calls.length).toBe(1)
    await service.close(); await rejected; expect(cleaned).toBe(true)
    await expect(service.repairPreview(g.grant, strokes)).rejects.toMatchObject({ statusCode: 503 })
  })
  it('preserves ordinary image upscale when repair dependencies are unavailable', async () => {
    control.repair = false
    const g = await imageGrant()
    await expect(service.repairPreview(g.grant, strokes)).rejects.toThrow('未安装图片修补模型')
    const task = await service.create({ grant: g.grant, kind: 'image', fileName: 'plain.png' })
    expect((await terminal(task.id)).status).toBe('succeeded')
  })
  it('does not authorize a preview if the source changes while it is being generated', async () => {
    const g = await imageGrant()
    vi.mocked(repairImagePreview).mockImplementationOnce(async (input) => { await writeFile(input, 'modified source'); return Buffer.from('PNG') })
    await expect(service.repairPreview(g.grant, strokes)).rejects.toThrow('发生变化')
  })
})

describe('output storage failure containment', () => {
  it('waits for owned subprocess cleanup instead of removing active work during storage retry', async () => {
    const g = await grant()
    let release!: () => void
    const settling = new Promise<void>((resolve) => { release = resolve })
    const settle = vi.spyOn(Processes.prototype, 'settle').mockImplementationOnce(() => settling)
    control.mode = 'enospc'
    try {
      const task = await service.create({ grant: g.grant, fileName: 'settling-storage.mp4' })
      expect((await terminal(task.id)).status).toBe('failed')
      const record = JSON.parse(String(db.prepare('SELECT snapshot FROM upscale_tasks WHERE id=?').get(task.id)!.snapshot))
      expect(record.work).toBeTruthy()
      expect((await service.capabilities(true)).capability.storageReason).toBeUndefined()
      expect((await stat(record.work)).isDirectory()).toBe(true)
      const active = (service as unknown as { active: { promise: Promise<void> } }).active
      release(); await active.promise
      await expect(stat(record.work)).rejects.toThrow()
    } finally { release(); settle.mockRestore() }
  })

  it.each(['enospc', 'message-full', 'quota'])('pauses the queue on output failure (%s) and resumes only after recheck', async (mode) => {
    const firstGrant = await grant(), secondGrant = await grant()
    control.mode = mode
    const first = await service.create({ grant: firstGrant.grant, fileName: 'output-full-first.mp4' })
    const second = await service.create({ grant: secondGrant.grant, fileName: 'output-full-second.mp4' })
    expect((await terminal(first.id)).error).toMatchObject({ code: 'STORAGE_FULL' })
    expect(service.get(second.id).status).toBe('queued')
    expect((await service.capabilities()).capability.storageReason).toContain('空间不足')
    await expect(service.authorize(input, root)).rejects.toMatchObject({ code: 'STORAGE_FULL' })
    await expect.poll(async () => (await readdir(root)).filter((name) => name.startsWith('.mediagrab-upscale-'))).toEqual([])
    control.fullOutputProbe = true
    expect((await service.capabilities(true)).capability.storageReason).toContain('空间不足')
    expect(service.get(second.id).status).toBe('queued')
    control.fullOutputProbe = false; control.mode = 'success'
    const space = vi.spyOn(await import('./pipeline.js'), 'checkSpace').mockRejectedValueOnce(Object.assign(new Error('insufficient reserved space'), { code: 'ENOSPC' }))
    expect((await service.capabilities(true)).capability.storageReason).toContain('空间不足')
    expect(service.get(second.id).status).toBe('queued')
    space.mockRestore()
    expect((await service.capabilities(true)).capability.storageReason).toBeUndefined()
    expect((await terminal(second.id)).status).toBe('succeeded')
  })
})

describe('recovery of an already published candidate', () => {
  async function seed(mode = 'published', kind: 'image' | 'video' = 'video') {
    await service.close()
    const id = randomUUID(), output = path.join(root, `recovered.${kind === 'image' ? 'png' : 'mp4'}`), work = path.join(root, `.mediagrab-upscale-${id}-crash`)
    const candidate = kind === 'image' ? path.join(work, 'out', 'input.png') : path.join(work, 'candidate.mp4'), bytes = Buffer.from('published candidate'), digest = createHash('sha256').update(bytes).digest('hex')
    await mkdir(work); if (kind === 'image') await mkdir(path.join(work, 'out')); await writeFile(path.join(work, 'owner.json'), JSON.stringify({ id: mode === 'wrong-owner' ? randomUUID() : id })); await writeFile(candidate, bytes)
    if (mode === 'unrelated') await writeFile(output, bytes)
    else if (mode === 'symlink') await symlink(candidate, output)
    else if (mode !== 'unpublished') await link(candidate, output)
    if (mode === 'tampered') await writeFile(output, Buffer.from('modified! candidate')) // same size, wrong digest
    const task = { id, kind, input, output, model: 'realesr-animevideov3-x2', status: 'running', stage: mode === 'wrong-stage' ? 'upscaling' : kind === 'image' ? 'done' : 'validating', completedFrames: 1, media: kind === 'image' ? { width: 400, height: 300, fps: '1/1', frames: 1, duration: 1, audio: false } : { width: 128, height: 72, fps: '24/1', frames: 26, duration: 26 / 24, audio: false }, createdAt: 1, updatedAt: 1 }
    db.prepare('INSERT INTO upscale_tasks VALUES(?,?,?)').run(id, JSON.stringify({ task, work, pendingOutput: { path: candidate, bytes: bytes.length, sha256: digest }, identity: 'old' }), 1)
    service = new UpscaleService(db); await service.close()
    return { id, output, work, digest }
  }
  it.each(['image', 'video'] as const)('restores %s success only from matching hard-link evidence after restart', async (kind) => {
    const { id, output, work, digest } = await seed('published', kind)
    expect(service.get(id)).toMatchObject({ status: 'succeeded', stage: 'done', result: { path: output, sha256: digest } })
    expect(service.get(id).error).toBeUndefined()
    expect(await readFile(output, 'utf8')).toBe('published candidate')
    await expect(stat(work)).rejects.toThrow()
    // A second restart reads the saved success, without needing the removed candidate.
    service = new UpscaleService(db); await service.close()
    expect(service.get(id).status).toBe('succeeded')
  })
  it('rejects nested candidate directories redirected through symlinks and preserves external files', async () => {
    await service.close()
    const id = randomUUID(), work = path.join(root, `.mediagrab-upscale-${id}-redirected`), external = path.join(root, 'external'), output = path.join(root, 'redirected.mp4')
    await mkdir(work); await mkdir(external); await writeFile(path.join(work, 'owner.json'), JSON.stringify({ id }))
    await writeFile(path.join(external, 'candidate'), 'external original'); await symlink(external, path.join(work, 'out'))
    const candidate = path.join(work, 'out', 'candidate'); await link(candidate, output)
    const task = { id, input, output, model: 'realesr-animevideov3-x2', status: 'running', stage: 'validating', completedFrames: 1, createdAt: 1, updatedAt: 1 }
    const pendingOutput = { path: candidate, bytes: Buffer.byteLength('external original'), sha256: createHash('sha256').update('external original').digest('hex') }
    db.prepare('INSERT INTO upscale_tasks VALUES(?,?,?)').run(id, JSON.stringify({ task, work, pendingOutput, identity: 'old' }), 1)
    service = new UpscaleService(db); await service.close()
    expect(service.get(id).status).toBe('interrupted')
    expect(await readFile(output, 'utf8')).toBe('external original')
    expect(await readFile(path.join(external, 'candidate'), 'utf8')).toBe('external original')
    await expect(stat(work)).rejects.toThrow()
  })
  it('rejects a candidate outside the owned work directory without using it for cleanup', async () => {
    await service.close()
    const id = randomUUID(), work = path.join(root, `.mediagrab-upscale-${id}-invalid`)
    await mkdir(work); await writeFile(path.join(work, 'owner.json'), JSON.stringify({ id }))
    const task = { id, input, output: path.join(root, 'unsafe.mp4'), model: 'realesr-animevideov3-x2', status: 'running', stage: 'validating', completedFrames: 1, createdAt: 1, updatedAt: 1 }
    db.prepare('INSERT INTO upscale_tasks VALUES(?,?,?)').run(id, JSON.stringify({ task, work, pendingOutput: { path: input, bytes: 8, sha256: 'a'.repeat(64) }, identity: 'old' }), 1)
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    service = new UpscaleService(db); await service.close()
    expect(service.list()).toEqual([])
    expect(warning).toHaveBeenCalledOnce()
    expect((await stat(work)).isDirectory()).toBe(true)
    expect(await readFile(input, 'utf8')).toBe('original')
  })
  it.each(['unpublished', 'unrelated', 'symlink', 'tampered', 'wrong-owner', 'wrong-stage'])('refuses unsafe recovery (%s) without deleting the output', async (mode) => {
    const { id, output, work } = await seed(mode)
    expect(service.get(id)).toMatchObject({ status: 'interrupted', error: { code: 'INTERRUPTED' } })
    expect(service.get(id).result).toBeUndefined()
    if (mode === 'symlink') expect((await lstat(output)).isSymbolicLink()).toBe(true)
    else if (mode !== 'unpublished') expect((await readFile(output)).length).toBeGreaterThan(0)
    if (mode === 'wrong-owner') expect((await stat(work)).isDirectory()).toBe(true)
    else await expect(stat(work)).rejects.toThrow()
  })
})

describe('storage failure containment', () => {
  function failWrites() {
    const prepare = db.prepare.bind(db)
    return vi.spyOn(db, 'prepare').mockImplementation((sql: string) => {
      if (sql.startsWith('INSERT INTO upscale_tasks')) throw new Error('SQLITE_FULL: database or disk is full')
      return prepare(sql)
    })
  }
  it('rejects failed initial persistence without accepting a ghost queued task', async () => {
    const g = await grant(), spy = failWrites()
    await expect(service.create({ grant: g.grant, fileName: 'not-accepted.mp4' })).rejects.toMatchObject({ code: 'STORAGE_FULL', statusCode: 503 })
    expect(service.list()).toEqual([])
    expect((await service.capabilities()).capability.storageReason).toContain('空间不足')
    spy.mockRestore()
    expect((await service.capabilities(true)).capability.storageReason).toBeUndefined()
  })
  it('contains background write failures, freezes queued jobs and recovers on explicit retry', async () => {
    const firstGrant = await grant(), secondGrant = await grant()
    control.mode = 'wait'
    const first = await service.create({ grant: firstGrant.grant, fileName: 'first-storage.mp4' })
    const second = await service.create({ grant: secondGrant.grant, fileName: 'second-storage.mp4' })
    await expect.poll(() => control.inFlight).toBe(1)
    const state = (service as unknown as { active: { promise: Promise<void> } }).active
    const spy = failWrites()
    service.cancel(first.id)
    await expect(state.promise).resolves.toBeUndefined()
    expect(service.get(first.id)).toMatchObject({ status: 'cancelled', storageWarning: expect.stringContaining('空间不足') })
    expect(service.get(second.id).status).toBe('queued')
    expect((await service.capabilities(true)).capability.storageReason).toContain('空间不足')
    spy.mockRestore(); control.mode = 'success'
    expect((await service.capabilities(true)).capability.storageReason).toBeUndefined()
    expect((await terminal(second.id)).status).toBe('succeeded')
    expect(service.get(first.id).storageWarning).toBeUndefined()
  })
  it('keeps a committed result successful when terminal-state persistence fails', async () => {
    const g = await grant(), prepare = db.prepare.bind(db)
    vi.spyOn(db, 'prepare').mockImplementation((sql: string) => {
      const statement = prepare(sql)
      if (!sql.startsWith('INSERT INTO upscale_tasks')) return statement
      return { run: (...args: Parameters<typeof statement.run>) => {
        if (JSON.parse(String(args[1])).task.status === 'succeeded') throw new Error('SQLITE_FULL: disk full at commit')
        return statement.run(...args)
      } } as typeof statement
    })
    const task = await service.create({ grant: g.grant, fileName: 'saved-despite-db.mp4' })
    const done = await terminal(task.id)
    expect(done).toMatchObject({ status: 'succeeded', result: { path: task.output }, storageWarning: expect.stringContaining('空间不足') })
    expect(await readFile(task.output, 'utf8')).toContain('unit fixture')
    await expect(service.close()).resolves.toBeUndefined()
    vi.restoreAllMocks()
    service = new UpscaleService(db); await service.close()
    expect(service.get(task.id)).toMatchObject({ status: 'succeeded', result: { path: task.output } })
    expect(service.get(task.id).storageWarning).toBeUndefined()
    expect((await readdir(root)).filter((name) => name.startsWith('.mediagrab-upscale-'))).toEqual([])
  })
  it('isolates throwing event listeners from task state and scheduling', async () => {
    service.subscribe(() => { throw new Error('listener failed') })
    const g = await grant(), task = await service.create({ grant: g.grant, fileName: 'listener.mp4' })
    expect((await terminal(task.id)).status).toBe('succeeded')
  })
})
