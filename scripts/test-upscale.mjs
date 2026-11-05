/** Opt-in real model acceptance. Run after pnpm build; never starts the desktop app. */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, readdirSync, statSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Database } from '../apps/server/dist/store/db.js'
import { UpscaleService } from '../apps/server/dist/upscale/service.js'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
// Fixture generation may use a developer FFmpeg; processing must use the pinned tools.
const ffmpeg = path.join(process.env.MEDIAGRAB_UPSCALE_DIR ?? '', 'ffmpeg')
if (!path.isAbsolute(ffmpeg)) throw new Error('Set MEDIAGRAB_UPSCALE_DIR to explicit prepared dependencies')
const fixtureFfmpeg = process.env.UPSCALER_FIXTURE_FFMPEG ?? ffmpeg
if (!path.isAbsolute(fixtureFfmpeg)) throw new Error('Fixture FFmpeg must be an absolute path')
const taskTimeout = Number(process.env.UPSCALER_TEST_TIMEOUT_MS ?? 1200000)
if (!Number.isFinite(taskTimeout) || taskTimeout < 1000) throw new Error('Invalid test timeout')
const outputRoot = path.join(root, 'artifacts/upscale-validation')
await mkdir(outputRoot, { recursive: true })
const dir = await mkdtemp(path.join(outputRoot, 'run-'))
const db = Database.open(path.join(dir, 'test.db'))
const service = new UpscaleService(db)
const report = { directory: dir, date: new Date().toISOString(), platform: `${process.platform}-${process.arch}`, chip: execFileSync('/usr/sbin/sysctl', ['-n', 'machdep.cpu.brand_string'], { encoding: 'utf8' }).trim(), memoryBytes: Number(execFileSync('/usr/sbin/sysctl', ['-n', 'hw.memsize'], { encoding: 'utf8' })), settings: { batch: 12, tile: 256, threads: '1:1:1', encoderThreads: 4, decoderThreads: 2, lookahead: 8, maxrate: '80M' }, idleDriverRssKiB: process.memoryUsage().rss / 1024, cases: [], rejectedInputs: [] }
const hash = async (file) => { const h = createHash('sha256'); for await (const d of createReadStream(file)) h.update(d); return h.digest('hex') }
function snapshot(peaks) {
  const rows = execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,rss=,comm='], { encoding: 'utf8' }).trim().split('\n').map((s) => { const [, pid, ppid, rss, command] = s.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/) ?? []; return { pid: Number(pid), ppid: Number(ppid), rss: Number(rss), command } })
  const owned = new Set([process.pid]); let added = true
  while (added) { added = false; for (const r of rows) if (owned.has(r.ppid) && !owned.has(r.pid)) { owned.add(r.pid); added = true } }
  let ffmpegSum = 0, supervisorSum = 0, ownedSum = 0, engineRunning = false
  for (const r of rows) {
    if (!owned.has(r.pid)) continue
    // Exclude the short-lived ps measurement helper from the processing tree total.
    if (!r.command?.endsWith('/ps')) ownedSum += r.rss
    const category = r.pid === process.pid ? 'driver' : r.command?.includes('realesrgan') ? 'engine' : r.command?.includes('ffmpeg') ? 'ffmpegProcess' : r.command?.includes('ffprobe') ? 'ffprobe' : r.command?.endsWith('/node') ? 'supervisor' : null
    if (category) peaks[category] = Math.max(peaks[category] ?? 0, r.rss)
    if (category === 'engine' && r.rss >= 50 * 1024) engineRunning = true
    if (category === 'supervisor') supervisorSum += r.rss
    if (category === 'ffmpegProcess') ffmpegSum += r.rss
  }
  peaks.concurrentOwnedTree = Math.max(peaks.concurrentOwnedTree ?? 0, ownedSum)
  peaks.concurrentFfmpegSum = Math.max(peaks.concurrentFfmpegSum ?? 0, ffmpegSum)
  peaks.concurrentSupervisorSum = Math.max(peaks.concurrentSupervisorSum ?? 0, supervisorSum)
  return engineRunning
}
function scratchSnapshot(peaks) {
  let bytes = 0, pngs = 0
  const visit = (folder) => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const file = path.join(folder, entry.name)
      if (entry.isDirectory()) visit(file)
      else if (entry.isFile()) { bytes += statSync(file).size; if (entry.name.endsWith('.png')) pngs++ }
    }
  }
  try { for (const name of readdirSync(dir)) if (name.startsWith('.mediagrab-upscale-')) visit(path.join(dir, name)) } catch (e) { if (e.code !== 'ENOENT') throw e }
  peaks.scratchLogicalBytes = Math.max(peaks.scratchLogicalBytes ?? 0, bytes)
  peaks.pngFiles = Math.max(peaks.pngFiles ?? 0, pngs)
}
async function execute(input, name, cancel = false) {
  const before = await hash(input)
  const start = performance.now(), peaks = {}
  const grant = await service.authorize(input, dir)
  const task = await service.create({ grant: grant.grant, fileName: name })
  let didCancel = false
  const timer = setInterval(() => {
    const engineRunning = snapshot(peaks)
    scratchSnapshot(peaks)
    if (cancel && !didCancel && engineRunning) { didCancel = true; service.cancel(task.id) }
  }, 50)
  let result
  try {
    for (;;) { if (performance.now() - start > taskTimeout) throw new Error('Real upscale test timed out'); result = service.get(task.id); if (!['queued', 'running'].includes(result.status)) break; await new Promise((r) => setTimeout(r, 100)) }
    // settle cleanup before checking directories / process liveness
    await new Promise((r) => setTimeout(r, 200))
  } finally { clearInterval(timer) }
  assert.equal(await hash(input), before, 'source must not change')
  if (cancel) assert.equal(didCancel, true, 'cancel must observe a real running inference process')
  assert.equal(result.status, cancel ? 'cancelled' : 'succeeded', JSON.stringify(result.error))
  if (cancel) await assert.rejects(stat(path.join(dir, name)))
  else { assert.equal(result.completedFrames, result.media.frames); assert.equal(await hash(result.result.path), result.result.sha256) }
  const record = { task: result, elapsedSeconds: (performance.now() - start) / 1000, sampledPeakRssKiB: peaks, sourceSha256: before }
  assert.ok((peaks.pngFiles ?? 0) <= 24, 'bounded batch must not accumulate whole-video PNGs')
  report.cases.push(record)
  console.log(JSON.stringify(record, null, 2))
  return result
}
try {
  report.capability = (await service.capabilities()).capability
  assert.equal(report.capability.available, true, report.capability.reason)
  const selectedCases = new Set((process.env.UPSCALER_TEST_CASES ?? 'synthetic,unsupported,cancel,reference').split(','))
  if (selectedCases.has('synthetic')) for (const [audio, fps] of [[false, '24'], [true, '24000/1001']]) {
    const input = path.join(dir, audio ? '-中文 AAC "样本; .mp4' : '中文 无音轨.mp4')
    execFileSync(fixtureFfmpeg, ['-v', 'error', '-f', 'lavfi', '-i', `testsrc2=size=128x72:rate=${fps}`, ...(audio ? ['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000'] : []), '-frames:v', '26', ...(audio ? ['-t', String(26 / (24000 / 1001)), '-c:a', 'aac'] : ['-an']), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-bf', '0', input])
    const out = await execute(input, audio ? 'aac-2x.mp4' : 'silent-2x.mp4')
    if (audio) assert.match(out.result.audioSha256, /^SHA256=/)
    const g = await service.authorize(input, dir)
    await assert.rejects(service.create({ grant: g.grant, fileName: path.basename(out.output) }), /已存在/)
    const same = await service.authorize(input, dir)
    await assert.rejects(service.create({ grant: same.grant, fileName: path.basename(input) }), /源文件/)
  }
  const silent = path.join(dir, '中文 无音轨.mp4')
  // Real containers exercise ffprobe and the admission path, not a mocked metadata object.
  if (selectedCases.has('unsupported')) for (const [kind, args, expected] of [
    ['HDR', ['-i', silent, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-color_primaries', 'bt2020', '-color_trc', 'smpte2084', '-colorspace', 'bt2020nc'], /HDR|色彩/],
    ['VFR', ['-i', silent, '-vf', 'select=not(eq(n\\,12))', '-fps_mode', 'vfr', '-c:v', 'libx264', '-pix_fmt', 'yuv420p'], /恒定帧率|可变帧率|VFR|时间线/],
    ['rotation', ['-display_rotation:v:0', '90', '-i', silent, '-c', 'copy'], /显示矩阵|旋转|元数据/],
    ['multitrack', ['-i', silent, '-map', '0:v:0', '-map', '0:v:0', '-c', 'copy'], /多轨|单视频轨/],
  ]) {
    const input = path.join(dir, `unsupported-${kind}.mp4`)
    execFileSync(fixtureFfmpeg, ['-v', 'error', ...args, input])
    const before = await hash(input)
    let error
    try { await service.authorize(input, dir) } catch (e) { error = e }
    assert.ok(error instanceof Error, `${kind} must fail before creating an inference task`)
    assert.match(error.message, expected)
    assert.equal(await hash(input), before)
    report.rejectedInputs.push({ kind, reason: error.message, sha256: before })
  }
  if (selectedCases.has('cancel')) await execute(silent, 'cancelled.mp4', true)
  const reference = process.env.UPSCALER_REFERENCE_VIDEO
  if (reference && selectedCases.has('reference')) {
    const referenceHash = await hash(reference)
    report.reference = { source: reference, sha256: referenceHash }
    const full = process.env.UPSCALER_REFERENCE_FULL === '1'
    let selected = reference
    if (!full) {
      // Stream-copy just 26 frames for a quick check. Full mode processes original AAC too.
      selected = path.join(dir, 'original-1080p-26frames.mp4')
      execFileSync(fixtureFfmpeg, ['-v', 'error', '-i', reference, '-map', '0:v:0', '-frames:v', '26', '-an', '-c:v', 'copy', selected])
    }
    report.reference.full = full
    try {
    const result = await execute(selected, full ? 'original-4k-full-aac.mp4' : 'original-4k-26frames.mp4')
    assert.equal(result.media.width, 1920); assert.equal(result.media.height, 1080)
    if (full) { assert.equal(result.media.frames, 338); assert.equal(result.media.audio, true); assert.match(result.result.audioSha256, /^SHA256=/) }
    assert.equal(await hash(reference), referenceHash)
    } catch (error) { report.reference.failure = error instanceof Error ? error.message : String(error); throw error }
  }
} catch (error) {
  report.failure = error instanceof Error ? error.stack : String(error)
  throw error
} finally {
  await service.close(); db.close()
  report.leftoverWorkDirs = (await readdir(dir)).filter((s) => s.startsWith('.mediagrab-upscale-'))
  report.afterCloseDriverRssKiB = process.memoryUsage().rss / 1024
  report.measurement = 'Sampled RSS every 50ms; owned tree excludes ps. RSS is not GPU allocation, unique physical memory or whole desktop-app memory. Scratch is logical bytes.'
  report.finishedAt = new Date().toISOString()
  await writeFile(path.join(dir, 'report.json'), JSON.stringify(report, null, 2) + '\n')
  console.log('REPORT', path.join(dir, 'report.json'))
}
assert.deepEqual(report.leftoverWorkDirs, [])
