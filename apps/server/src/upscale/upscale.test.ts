import { afterEach, describe, expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { Readable } from 'node:stream'
import { mkdtemp, readFile, writeFile, symlink, chmod, rm, realpath } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { upscaleRecordSchema } from './record.js'
import { inspect, sameAudioTimeline, supportedImage, supportedMedia, timeline } from './probe.js'
import { pngSize } from './image-pipeline.js'
import { pngFrames, requiredSpace, ensureSpace } from './pipeline.js'
import { Processes } from './process.js'
import type { Tools } from './tools.js'
import { inputIdentity } from './service.js'
import { upscaleCreateSchema } from '@mediagrab/shared'

function probe() { return { streams: [{ codec_type: 'video', codec_name: 'h264', pix_fmt: 'yuv420p', width: 128, height: 72, r_frame_rate: '24/1', avg_frame_rate: '24/1', nb_read_frames: '26', duration: '1.083333', start_time: '0', color_transfer: 'bt709', color_primaries: 'bt709', color_space: 'bt709', sample_aspect_ratio: '1:1' }], format: { duration: '1.083333' } } }
const temporary: string[] = []
afterEach(async () => { await Promise.all(temporary.splice(0).map((p) => rm(p, { recursive: true, force: true }))) })
describe('image upscale input boundaries', () => {
  const imageProbe = (change: Record<string, unknown> = {}) => ({
    streams: [{ codec_type: 'video', codec_name: 'png', width: 1200, height: 800, ...change }],
    format: { format_name: 'image2' },
  })
  it('accepts a single PNG or JPEG within the pixel limits', () => {
    expect(supportedImage(imageProbe())).toMatchObject({ width: 1200, height: 800, frames: 1, fps: '1/1', audio: false })
    expect(supportedImage(imageProbe({ codec_name: 'mjpeg' })).width).toBe(1200)
  })
  it.each([
    ['unsupported codec', { codec_name: 'webp' }], ['too many frames', { nb_frames: '2' }],
    ['oversized image', { width: 4096, height: 4096 }], ['orientation metadata', { side_data_list: [{ rotation: 90 }] }],
  ])('rejects %s', (_, change) => { expect(() => supportedImage(imageProbe(change))).toThrow() })
  it('rejects multiple streams and non-image sources', () => {
    expect(() => supportedImage({ ...imageProbe(), streams: [...imageProbe().streams, { codec_type: 'audio' }] })).toThrow()
  })
  it('reads PNG dimensions from the IHDR header', () => {
    const header = Buffer.alloc(24)
    Buffer.from('89504e470d0a1a0a', 'hex').copy(header)
    header.write('IHDR', 12, 'ascii'); header.writeUInt32BE(640, 16); header.writeUInt32BE(360, 20)
    expect(pngSize(header)).toEqual({ width: 640, height: 360 })
    expect(() => pngSize(Buffer.alloc(24))).toThrow('PNG')
  })
})

describe('upscale input boundaries', () => {
  it('accepts CFR SDR and preserves the rational rate', () => { expect(supportedMedia(probe()).frames).toBe(26) })
  it.each([
    ['HDR', { color_transfer: 'smpte2084' }], ['10 bit', { pix_fmt: 'yuv420p10le' }],
    ['oversized', { width: 3840 }], ['odd size', { width: 127 }], ['unknown frames and stream duration', { nb_read_frames: 'N/A', duration: 'N/A' }],
    ['too many frames', { nb_read_frames: '36001' }], ['VFR', { avg_frame_rate: '23/1' }],
    ['rotation', { side_data_list: [{ rotation: 90 }] }], ['non-square pixel', { sample_aspect_ratio: '2:1' }],
    ['nonzero start', { start_time: '1' }], ['unknown start', { start_time: 'N/A' }], ['unknown stream duration', { duration: 'N/A' }], ['unknown fps', { avg_frame_rate: '0/0' }],
  ])('rejects %s', (_, change) => {
    const p = probe(); Object.assign(p.streams[0]!, change); expect(() => supportedMedia(p)).toThrow()
  })
  it('rejects unknown duration and long videos', () => {
    const p = probe(); p.format.duration = 'N/A'; expect(() => supportedMedia(p)).toThrow(); p.format.duration = '601'; expect(() => supportedMedia(p)).toThrow()
  })
  it('accepts exactly 10 minutes and 36,000 frames but rejects the next frame', () => {
    const p = probe()
    Object.assign(p.streams[0]!, { width: 1920, height: 1080, r_frame_rate: '60/1', avg_frame_rate: '60/1', nb_read_frames: '36000', duration: '600' })
    p.format.duration = '600'
    expect(supportedMedia(p)).toMatchObject({ width: 1920, height: 1080, fps: '60/1', frames: 36000, duration: 600 })
    Object.assign(p.streams[0]!, { nb_read_frames: '36001', duration: '600.016667' })
    p.format.duration = '600.016667'
    expect(() => supportedMedia(p)).toThrow('超过安全上限')
  })
  it('rejects additional tracks, subtitles, chapters and incompatible audio', () => {
    for (const stream of [{ codec_type: 'subtitle' }, { codec_type: 'audio', codec_name: 'opus' }, { codec_type: 'audio', codec_name: 'aac', channels: 6 }]) {
      const p = probe(); p.streams.push(stream as typeof p.streams[number]); expect(() => supportedMedia(p)).toThrow()
    }
    expect(() => supportedMedia({ ...probe(), chapters: [{}] })).toThrow()
  })
  it('scales the conservative disk allowance with video duration and dimensions', () => {
    const m = supportedMedia(probe()); expect(requiredSpace({ ...m, duration: 600, width: 1920, height: 1080 }, 100)).toBeGreaterThan(12_000_000_000)
  })
  it.each(['../input.mp4', '/tmp/out.mp4', '-f\n.mp4', '.hidden.mp4', 'a\\b.mp4'])('rejects output path injection %s', (fileName) => {
    expect(upscaleCreateSchema.safeParse({ grant: 'f6bf36b6-33af-477b-aef5-5b7c369bdb16', fileName }).success).toBe(false)
  })
  it('allows Chinese, quotes, spaces and a leading dash in an output basename', () => {
    expect(upscaleCreateSchema.safeParse({ grant: 'f6bf36b6-33af-477b-aef5-5b7c369bdb16', fileName: '-中文 "片源; 2x.mp4' }).success).toBe(true)
  })
  it('accepts selected PNG/JPEG images but keeps video inputs MP4-only', async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'upscale-images-'))); temporary.push(root)
    for (const extension of ['png', 'jpg', 'jpeg']) {
      const file = path.join(root, `image.${extension}`); await writeFile(file, 'source')
      expect(await inputIdentity(file, 'image')).toEqual(expect.any(String))
      await expect(inputIdentity(file)).rejects.toThrow('MP4')
    }
    const video = path.join(root, 'video.mp4'); await writeFile(video, 'source')
    await expect(inputIdentity(video, 'image')).rejects.toThrow('PNG/JPG/JPEG')
  })
  it('rejects symlinks, unreadable files, directories, and detects source replacement', async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'upscale-files-'))); temporary.push(root)
    const file = path.join(root, 'input.mp4'); await writeFile(file, 'source')
    const before = await inputIdentity(file); await writeFile(file, 'replacement'); expect(await inputIdentity(file)).not.toBe(before)
    const alias = path.join(root, 'alias.mp4'); await symlink(file, alias); await expect(inputIdentity(alias)).rejects.toThrow()
    await chmod(file, 0); await expect(inputIdentity(file)).rejects.toThrow(); await chmod(file, 0o600)
    await expect(inputIdentity(root)).rejects.toThrow()
  })
})
describe('bounded PNG stream', () => {
  const png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.from('0000000049454e4400000000', 'hex')])
  it('splits arbitrary chunks and flushes the last incomplete batch', async () => {
    const data = Buffer.concat(Array.from({ length: 26 }, () => png))
    const pieces = Array.from({ length: Math.ceil(data.length / 7) }, (_, i) => data.subarray(i * 7, i * 7 + 7))
    const frames = []; for await (const f of pngFrames(Readable.from(pieces))) frames.push(f)
    expect(frames).toHaveLength(26); expect(frames.every((f) => f.equals(png))).toBe(true)
  })
  it('rejects truncated frames and invalid signatures', async () => {
    const collect = async (b: Buffer) => { for await (const _ of pngFrames(Readable.from([b]))) { /* drain */ } }
    await expect(collect(png.subarray(0, -1))).rejects.toThrow('不完整')
    await expect(collect(Buffer.alloc(20))).rejects.toThrow('帧头')
  })
})
describe('owned subprocesses', () => {
  it('cancels and reaps its child without a shell', async () => {
    const abort = new AbortController(); const processes = new Processes(abort.signal)
    const { child, done } = processes.start(process.execPath, ['-e', 'setInterval(()=>{},1000)'])
    child.stdout.resume(); abort.abort(); await expect(done).rejects.toThrow('取消'); await processes.settle()
    expect(() => process.kill(child.pid!, 0)).toThrow()
  })
  it('reports failures, missing tools and refuses already cancelled starts', async () => {
    const abort = new AbortController(); const p = new Processes(abort.signal)
    await expect(p.run(process.execPath, ['-e', 'process.exit(7)'])).rejects.toThrow('7')
    await expect(p.run('/nonexistent/upscale-tool', [])).rejects.toThrow()
    abort.abort(); expect(() => p.start(process.execPath, [])).toThrow(); await p.settle()
  })
})

it('watchdog reaps a tool after abrupt core SIGKILL (no application or listening port)', async () => {
  const supervisor = fileURLToPath(new URL('./supervise.mjs', import.meta.url))
  const code = `
    const {spawn}=require('node:child_process');
    const toolCode='console.log(process.pid);setInterval(()=>{},1000)';
    const wrapper=spawn(process.execPath,[${JSON.stringify(supervisor)},process.execPath,'-e',toolCode],{stdio:['pipe','pipe','pipe','ipc']});
    wrapper.stdout.once('data',data=>process.stdout.write(JSON.stringify({wrapper:wrapper.pid,tool:Number(data.toString().trim())})+'\\n'));
    setInterval(()=>{},1000);
  `
  const owner = spawn(process.execPath, ['-e', code], { stdio: ['ignore', 'pipe', 'pipe'] })
  let pids: { wrapper: number; tool: number } | undefined
  try {
    pids = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('watchdog fixture timed out')), 3000)
      owner.stdout.once('data', (b) => { clearTimeout(timer); try { resolve(JSON.parse(b.toString())) } catch (e) { reject(e) } })
      owner.once('error', reject)
    })
    owner.kill('SIGKILL')
    for (let i = 0; i < 200; i++) {
      let alive = false
      for (const pid of [pids!.tool, pids!.wrapper]) try { process.kill(pid, 0); alive = true } catch { /* gone */ }
      if (!alive) return
      await new Promise((r) => setTimeout(r, 10))
    }
    throw new Error('orphaned supervised process')
  } finally {
    owner.kill('SIGKILL')
    if (pids) for (const pid of [pids.tool, pids.wrapper]) try { process.kill(pid, 'SIGKILL') } catch { /* gone */ }
  }
})

it('rejects insufficient/unknown free disk before generating frames', () => {
  const media = supportedMedia(probe())
  expect(() => ensureSpace(512 * 1024 ** 2, media, 100)).toThrow('空间不足')
  expect(() => ensureSpace(NaN, media, 100)).toThrow('空间不足')
  const required = requiredSpace(media, 100)
  expect(() => ensureSpace(required, media, 100)).not.toThrow()
  expect(() => ensureSpace(required - 1, media, 100)).toThrow('空间不足')
})
it('checks actual PTS for hidden VFR and requires monotonic output DTS', async () => {
  const media = supportedMedia(probe())
  const frames = Array.from({ length: 26 }, (_, i) => ({ best_effort_timestamp_time: String(i / 24), pkt_dts_time: String(i / 24) }))
  const processFixture = { run: async () => JSON.stringify({ frames }) } as unknown as Processes
  const tools = { ffmpeg: 'fixture', ffprobe: 'fixture', engine: 'fixture', models: 'fixture' }
  await expect(timeline('fixture', media, tools, processFixture, true)).resolves.toBeUndefined()
  frames[12]!.best_effort_timestamp_time = '0.51'
  await expect(timeline('fixture', media, tools, processFixture)).rejects.toThrow('VFR')
  frames[12]!.best_effort_timestamp_time = String(12 / 24); frames[12]!.pkt_dts_time = '0'
  await expect(timeline('fixture', media, tools, processFixture, true)).rejects.toThrow('DTS')
})
it.each(['24/1', '24000/1001', '60/1'])('accepts millisecond-rounded CFR input at %s without loosening output checks', async (fps) => {
  const [n, d] = fps.split('/').map(Number)
  const frameRate = n! / d!
  // Covers an entire long clip; compare to the global grid to catch drift.
  const media = { ...supportedMedia(probe()), fps, frames: 4464, duration: 4464 / frameRate }
  const frames = Array.from({ length: media.frames }, (_, i) => ({ best_effort_timestamp_time: (Math.round(i / frameRate * 1000) / 1000).toFixed(6) }))
  const processFixture = { run: async () => JSON.stringify({ frames }) } as unknown as Processes
  const tools = { ffmpeg: 'fixture', ffprobe: 'fixture', engine: 'fixture', models: 'fixture' }
  await expect(timeline('fixture', media, tools, processFixture)).resolves.toBeUndefined()
  // Use an exact first DTS so output rejection is specifically due to rounded PTS.
  const withDts = { run: async () => JSON.stringify({ frames: frames.map((f) => ({ ...f, pkt_dts_time: f.best_effort_timestamp_time })) }) } as unknown as Processes
  await expect(timeline('fixture', media, tools, withDts, true)).rejects.toThrow('PTS')
})
it.each(['jitter', 'duplicate', 'missing frame', 'drift', 'nonzero start', 'invalid PTS', 'wrong count'])('still rejects %s in a millisecond-rounded input timeline', async (kind) => {
  const media = supportedMedia(probe())
  const frames = Array.from({ length: media.frames }, (_, i) => ({ best_effort_timestamp_time: (Math.round(i / 24 * 1000) / 1000).toFixed(6) }))
  switch (kind) {
    case 'jitter': frames[12]!.best_effort_timestamp_time = '0.501000'; break
    case 'duplicate': frames[12]!.best_effort_timestamp_time = frames[11]!.best_effort_timestamp_time; break
    case 'missing frame': for (let i = 12; i < frames.length; i++) frames[i]!.best_effort_timestamp_time = String((i + 1) / 24); break
    case 'drift': for (let i = 0; i < frames.length; i++) frames[i]!.best_effort_timestamp_time = String(i / 24 + i * 0.0001); break
    case 'nonzero start': for (let i = 0; i < frames.length; i++) frames[i]!.best_effort_timestamp_time = String(i / 24 + 0.0003); break
    case 'invalid PTS': frames[12]!.best_effort_timestamp_time = 'N/A'; break
    case 'wrong count': frames.pop(); break
  }
  const processFixture = { run: async () => JSON.stringify({ frames }) } as unknown as Processes
  const tools = { ffmpeg: 'fixture', ffprobe: 'fixture', engine: 'fixture', models: 'fixture' }
  await expect(timeline('fixture', media, tools, processFixture)).rejects.toThrow(/PTS|帧数/)
})
it('requires exact AAC packet timestamps and durations after stream copy', () => {
  const original = [{ pts_time: '0.000000', dts_time: '0.000000', duration_time: '0.021333' }, { pts_time: '0.021333', dts_time: '0.021333', duration_time: '0.021333' }]
  expect(sameAudioTimeline(original, structuredClone(original))).toBe(true)
  expect(sameAudioTimeline(original, [original[0]!, { ...original[1]!, pts_time: '0.022000' }])).toBe(false)
  expect(sameAudioTimeline(original, original.slice(0, 1))).toBe(false)
})

it('bounds UTF-8 and decomposed Unicode output names before filesystem operations', () => {
  const grant = 'f6bf36b6-33af-477b-aef5-5b7c369bdb16'
  for (const fileName of ['中'.repeat(79) + '.mp4', 'é'.repeat(80) + '.mp4', '😀'.repeat(60) + '.mp4']) {
    expect(upscaleCreateSchema.safeParse({ grant, fileName }).success).toBe(false)
  }
  expect(upscaleCreateSchema.safeParse({ grant, fileName: '中'.repeat(78) + '.mp4' }).success).toBe(true)
})

it('reaps a detached tool on output overflow even if it ignores SIGTERM', async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'upscale-overflow-'))); temporary.push(root)
  const pidFile = path.join(root, 'pid')
  const processes = new Processes(new AbortController().signal)
  const code = `require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));process.on('SIGTERM',()=>{});process.stdout.write('x'.repeat(4096));setInterval(()=>{},1000)`
  await expect(processes.run(process.execPath, ['-e', code], 32)).rejects.toThrow('安全上限')
  await processes.settle()
  const pid = Number(await readFile(pidFile, 'utf8'))
  expect(() => process.kill(pid, 0)).toThrow()
})

it('validates persisted snapshots at the storage trust boundary', () => {
  const id = '56465656-466b-4666-8666-566666666666'
  const base = { task: { id, input: '/tmp/input.mp4', output: '/tmp/output.mp4', model: 'realesr-animevideov3-x2', status: 'running', stage: 'upscaling', completedFrames: 12, createdAt: 1, updatedAt: 2 }, identity: '1:2:3:4:5', work: '/tmp/.mediagrab-upscale-56465656-466b-4666-8666-566666666666-test' }
  expect(upscaleRecordSchema.safeParse(base).success).toBe(true)
  for (const invalid of [
    { ...base, task: { ...base.task, id: 'other' } },
    { ...base, work: '/tmp/foreign' },
    { ...base, task: { ...base.task, completedFrames: 36001 } },
    { ...base, task: { ...base.task, stage: 'untrusted' } },
    { ...base, task: { ...base.task, result: { path: '/tmp/out', bytes: 1, sha256: 'not-hash' } } },
  ]) expect(upscaleRecordSchema.safeParse(invalid).success).toBe(false)
})


function roundedThirtyFpsProbe() {
  const fixture = probe()
  Object.assign(fixture.streams[0]!, { r_frame_rate: '30/1', avg_frame_rate: '11808000/393599', nb_frames: '738', nb_read_frames: '738', duration: '24.599937' })
  fixture.format.duration = '24.618292'
  return fixture
}

describe('CFR frame-rate metadata rounding', () => {
  it('recognizes the 738-frame MV as exactly 30 fps instead of rejecting 30.000076 average metadata', async () => {
    const media = supportedMedia(roundedThirtyFpsProbe())
    expect(media).toMatchObject({ fps: '30/1', frames: 738, duration: 24.6 })
    const frames = Array.from({ length: media.frames }, (_, i) => ({ best_effort_timestamp_time: (Math.round(i / 30 * 16000) / 16000).toFixed(6) }))
    const fixtureProcesses = { run: async () => JSON.stringify({ frames }) } as unknown as Processes
    await expect(timeline('fixture', media, { ffprobe: 'fixture' } as Tools, fixtureProcesses)).resolves.toBeUndefined()
    frames[369]!.best_effort_timestamp_time = String(369 / 30 + 0.004)
    await expect(timeline('fixture', media, { ffprobe: 'fixture' } as Tools, fixtureProcesses)).rejects.toThrow('VFR')
  })
  it('infers a candidate frame count when MP4 metadata omits both frame-count fields', () => {
    const fixture = roundedThirtyFpsProbe()
    delete (fixture.streams[0]! as { nb_frames?: string }).nb_frames
    delete (fixture.streams[0]! as { nb_read_frames?: string }).nb_read_frames
    expect(supportedMedia(fixture)).toMatchObject({ frames: 738, fps: '30/1' })
  })
  it.each(['24/1', '24000/1001', '30000/1001', '30/1', '60/1'])('normalizes bounded average-rate rounding at %s, including the 60 fps boundary', (fps) => {
    const [n, d] = fps.split('/').map(Number)
    for (const tickOffset of [-1, 1]) {
      const fixture = probe(), frames = 738
      const ticks = Math.round(frames / (n! / d!) * 16000) + tickOffset
      Object.assign(fixture.streams[0]!, { r_frame_rate: fps, avg_frame_rate: `${frames * 16000}/${ticks}`, nb_frames: String(frames), nb_read_frames: String(frames), duration: String(ticks / 16000) })
      fixture.format.duration = String(ticks / 16000)
      expect(supportedMedia(fixture)).toMatchObject({ fps, frames, duration: frames / (n! / d!) })
    }
  })
  it('uses one metadata probe and leaves exact frame-count verification to the timestamp scan', async () => {
    const preliminary = roundedThirtyFpsProbe()
    delete (preliminary.streams[0]! as { nb_read_frames?: string }).nb_read_frames
    const calls: string[][] = []
    const fixtureProcesses = { run: async (_tool: string, args: string[]) => { calls.push(args); return JSON.stringify(preliminary) } } as unknown as Processes
    const inspected = await inspect('fixture', { ffprobe: 'fixture' } as Tools, fixtureProcesses)
    expect(calls).toHaveLength(1)
    expect(calls[0]).not.toContain('-count_frames')
    expect(supportedMedia(inspected).fps).toBe('30/1')
  })
  it('bounds cumulative drift even when the raw fps difference is tiny', () => {
    const fixture = probe()
    Object.assign(fixture.streams[0]!, { r_frame_rate: '60/1', avg_frame_rate: '60000060/1000000', nb_frames: '36000', nb_read_frames: '36000', duration: '600' })
    fixture.format.duration = '600'
    expect(() => supportedMedia(fixture)).toThrow('标称与平均帧率不一致')
  })
  it.each([
    ['30/1', '30000/1001'], ['60/1', '30/1'], ['0/0', '30/1'],
    ['30/1', '0/0'], ['30/1', 'N/A'], ['61/1', '61/1'], ['1/2', '1/2'],
    ['30/1', '-30/1'], ['30/0', '30/1'],
  ])('rejects unbounded or invalid frame-rate metadata %s / %s', (nominal, average) => {
    const fixture = roundedThirtyFpsProbe()
    Object.assign(fixture.streams[0]!, { r_frame_rate: nominal, avg_frame_rate: average })
    expect(() => supportedMedia(fixture)).toThrow(/帧率/)
  })
})
