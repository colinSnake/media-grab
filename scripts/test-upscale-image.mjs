import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { deflateSync } from 'node:zlib'
import { fileURLToPath, pathToFileURL } from 'node:url'
const runtime = process.env.MEDIAGRAB_IMAGE_RUNTIME || fileURLToPath(new URL('../apps/server/', import.meta.url))
assert.ok(path.isAbsolute(runtime), 'MEDIAGRAB_IMAGE_RUNTIME must be absolute when provided')
const load = (file) => import(pathToFileURL(path.join(runtime, 'dist', file)).href)
const { Database } = await load('store/db.js')
const { UpscaleService } = await load('upscale/service.js')
const { rasterizeMask } = await load('upscale/inpainting.js')
const { pngSize } = await load('upscale/image-pipeline.js')
const { Processes } = await load('upscale/process.js')

// Explicit local integration test only: never download models or use user media/data.
for (const name of ['MEDIAGRAB_UPSCALE_DIR', 'MEDIAGRAB_INPAINT_MODEL']) assert.ok(path.isAbsolute(process.env[name] || ''), `${name} must explicitly name an absolute local path`)
const table = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let i = 0; i < 8; i++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
function chunk(type, bytes) {
  const data = Buffer.concat([Buffer.from(type), bytes]), output = Buffer.alloc(data.length + 8)
  output.writeUInt32BE(bytes.length, 0); data.copy(output, 4)
  let crc = 0xffffffff
  for (const value of data) crc = table[(crc ^ value) & 255] ^ (crc >>> 8)
  output.writeUInt32BE((crc ^ 0xffffffff) >>> 0, output.length - 4)
  return output
}
function fixture(width, height) {
  const scanlines = Buffer.alloc((width * 4 + 1) * height)
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const p = y * (width * 4 + 1) + 1 + x * 4
    const covered = Math.abs(x / width - .5) < .025 && Math.abs(y / height - .5) < .025
    scanlines[p] = covered ? 255 : (x * 3 + y) % 256
    scanlines[p + 1] = covered ? 255 : (y * 2) % 256
    scanlines[p + 2] = covered ? 255 : (x + y * 3) % 256
    scanlines[p + 3] = covered ? 255 : 64 + (x % 192)
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('IDAT', deflateSync(scanlines)), chunk('IEND', Buffer.alloc(0))])
}
const hash = (buffer) => createHash('sha256').update(buffer).digest('hex')
const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'mediagrab-image-regression-')))
const db = Database.open(':memory:')
let service = new UpscaleService(db)
const repeat = Number(process.env.UPSCALER_IMAGE_REPEAT || 0)
assert.ok(Number.isInteger(repeat) && repeat >= 0 && repeat <= 10, 'UPSCALER_IMAGE_REPEAT must be an integer from 0 to 10')
const report = { testedAt: new Date().toISOString(), platform: `${process.platform}-${process.arch}`, runtime, node: process.version, cases: [] }
async function terminal(id) {
  const deadline = Date.now() + 10 * 60_000
  while (Date.now() < deadline) {
    const task = service.get(id)
    if (!['queued', 'running'].includes(task.status)) return task
    await new Promise((r) => setTimeout(r, 10))
  }
  throw new Error('Image regression exceeded its 10-minute timeout')
}
try {
  const { capability: cap, tools } = await service.capabilities()
  assert.equal(cap.imageAvailable, true, JSON.stringify(cap)); assert.equal(cap.repairAvailable, true, JSON.stringify(cap))
  const strokes = [{ radius: .06, points: [{ x: .5, y: .5 }] }]
  async function runCase(label, width, height, { repair = false, jpeg = false } = {}) {
    const start = Date.now(), source = path.join(root, `${label}.png`)
    await writeFile(source, fixture(width, height))
    let input = source
    if (jpeg) {
      input = path.join(root, `${label}.jpg`)
      execFileSync('/usr/bin/sips', ['-s', 'format', 'jpeg', source, '--out', input], { stdio: 'pipe' })
    }
    const originalHash = hash(await readFile(input)), grant = await service.authorize(input, root, 'image')
    let pixelEvidence
    if (repair) {
      const preview = await service.repairPreview(grant.grant, strokes)
      assert.deepEqual(pngSize(preview), { width, height })
      const previewFile = path.join(root, `${label}-preview.png`)
      await writeFile(previewFile, preview)
      const processes = new Processes(new AbortController().signal)
      async function rgba(file, suffix) {
        const output = path.join(root, `${label}-${suffix}.rgba`)
        await processes.run(tools.ffmpeg, ['-v', 'error', '-nostdin', '-f', 'image2', '-pattern_type', 'none', '-i', file, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgba', output])
        return readFile(output)
      }
      const before = await rgba(input, 'before'), after = await rgba(previewFile, 'after'), mask = rasterizeMask(width, height, strokes)
      assert.equal(before.length, after.length)
      let outsideMax = 0, insideDelta = 0, changedAlpha = 0
      for (let i = 0; i < width * height; i++) {
        if (before[i * 4 + 3] !== after[i * 4 + 3]) changedAlpha++
        for (let c = 0; c < 3; c++) {
          const delta = Math.abs(before[i * 4 + c] - after[i * 4 + c])
          if (mask[i]) insideDelta += delta; else outsideMax = Math.max(outsideMax, delta)
        }
      }
      assert.equal(changedAlpha, 0); assert.ok(outsideMax <= 1); assert.ok(insideDelta > 0)
      pixelEvidence = { outsideMax, insideDelta, changedAlpha }
    }
    const request = { grant: grant.grant, kind: 'image', fileName: `${label}-result.png`, ...(repair ? { repair: strokes } : {}) }
    const task = await service.create(request), done = await terminal(task.id)
    assert.equal(done.status, 'succeeded', JSON.stringify(done)); assert.deepEqual(pngSize(await readFile(done.output)), { width: width * 2, height: height * 2 })
    assert.equal(hash(await readFile(input)), originalHash)
    const evidence = { label, width, height, repair, elapsedMs: Date.now() - start, outputBytes: done.result.bytes, originalUnchanged: true, ...pixelEvidence }
    report.cases.push(evidence); console.log(JSON.stringify(evidence))
  }
  await runCase('png-rgba', 256, 192)
  await runCase('jpeg', 256, 192, { jpeg: true })
  await runCase('repair-rgba', 512, 512, { repair: true })
  // No-overwrite, corrupt data, and actual process cancellation use the real service.
  const source = path.join(root, 'cancel.png'); await writeFile(source, fixture(1024, 1024))
  const occupied = path.join(root, 'occupied.png'); await writeFile(occupied, 'existing user output')
  const occupiedGrant = await service.authorize(source, root, 'image')
  await assert.rejects(service.create({ grant: occupiedGrant.grant, kind: 'image', fileName: 'occupied.png' }), /已存在/)
  assert.equal(await readFile(occupied, 'utf8'), 'existing user output')
  const broken = path.join(root, 'broken.png'); await writeFile(broken, 'not an image')
  await assert.rejects(service.authorize(broken, root, 'image'))
  const cancelGrant = await service.authorize(source, root, 'image')
  const cancelling = await service.create({ grant: cancelGrant.grant, kind: 'image', fileName: 'cancelled.png' })
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline && service.get(cancelling.id).stage !== 'upscaling' && service.get(cancelling.id).status === 'running') await new Promise(r => setTimeout(r, 2))
  assert.equal(service.get(cancelling.id).stage, 'upscaling'); service.cancel(cancelling.id)
  assert.equal((await terminal(cancelling.id)).status, 'cancelled')
  assert.ok(!(await readdir(root)).includes('cancelled.png'))
  report.cases.push({ label: 'corrupt-input-no-overwrite-real-upscale-cancel', passed: true })
  // Real abrupt exit after hard-link publication, before the successful SQLite write.
  // The child owns only this temporary database and fixture; no application process is killed.
  const crashDb = path.join(root, 'crash-recovery.sqlite'), crashOutput = path.join(root, 'crash-recovered.png'), crashMarker = path.join(root, 'crash-marker')
  const crashScript = `
    import { pathToFileURL } from 'node:url';
    import { writeFileSync } from 'node:fs';
    const { Database } = await import(pathToFileURL(${JSON.stringify(path.join(runtime, 'dist/store/db.js'))}).href);
    const { UpscaleService } = await import(pathToFileURL(${JSON.stringify(path.join(runtime, 'dist/upscale/service.js'))}).href);
    const db = Database.open(${JSON.stringify(crashDb)}), prepare = db.prepare.bind(db);
    db.prepare = (sql) => {
      const statement = prepare(sql);
      if (!sql.startsWith('INSERT INTO upscale_tasks')) return statement;
      return { run: (...args) => {
        if (JSON.parse(String(args[1])).task.status === 'succeeded') {
          writeFileSync(${JSON.stringify(crashMarker)}, 'reached-success-persistence');
          process.kill(process.pid, 'SIGKILL');
        }
        return statement.run(...args);
      } };
    };
    const service = new UpscaleService(db);
    const grant = await service.authorize(${JSON.stringify(source)}, ${JSON.stringify(root)}, 'image');
    await service.create({ grant: grant.grant, kind: 'image', fileName: 'crash-recovered.png' });
  `
  let crashSignal
  try { execFileSync(process.execPath, ['--input-type=module', '-e', crashScript], { timeout: 60_000, stdio: 'pipe' }) }
  catch (error) {
    crashSignal = error.signal
    if (crashSignal !== 'SIGKILL') throw new Error(`Crash fixture exited before the intended SIGKILL: ${error.stderr?.toString() ?? error.message}`, { cause: error })
  }
  assert.equal(crashSignal, 'SIGKILL')
  assert.equal(await readFile(crashMarker, 'utf8'), 'reached-success-persistence', 'crash fixture must reach the post-publication success write')
  const recoveredDb = Database.open(crashDb), recoveredService = new UpscaleService(recoveredDb)
  try {
    await recoveredService.close() // waits for ownership/inode/hash recovery and cleanup
    const recovered = recoveredService.list()[0]
    assert.equal(recovered.status, 'succeeded'); assert.equal(recovered.output, crashOutput)
    assert.equal(recovered.result.sha256, hash(await readFile(crashOutput)))
    assert.deepEqual(pngSize(await readFile(crashOutput)), { width: 2048, height: 2048 })
    report.cases.push({ label: 'sigkill-after-output-before-sqlite-success', signal: crashSignal, reachedSuccessWrite: true, recoveredStatus: recovered.status, outputVerified: true })
  } finally { await recoveredService.close(); recoveredDb.close() }
  // Optional bounded endurance run. Observe the runner's actual inference boundary,
  // not a guessed delay; cancellation must reap only our supervised child groups.
  for (let cycle = 1; cycle <= repeat; cycle++) {
    const originalStart = Processes.prototype.start, ownedPids = new Set(), previewWork = new Set()
    const controller = new AbortController()
    let inferenceStarted = false
    const previewGrant = await service.authorize(source, root, 'image')
    Processes.prototype.start = function (executable, args, options) {
      const process = originalStart.call(this, executable, args, options)
      if (process.child.pid) ownedPids.add(process.child.pid)
      if (args.some((arg) => arg.endsWith('/inpainting-runner.mjs')) && !args.includes('--check-runtime')) {
        previewWork.add(path.dirname(args[2]))
        let output = ''
        process.child.stdout.on('data', (bytes) => {
          output += bytes.toString()
          if (!inferenceStarted && output.includes('MEDIAGRAB_INPAINT_INFERENCE_STARTED')) {
            inferenceStarted = true
            const rows = execFileSync('/bin/ps', ['-axo', 'pid=,ppid='], { encoding: 'utf8' })
            for (const row of rows.trim().split('\n')) {
              const [pid, ppid] = row.trim().split(/\s+/).map(Number)
              if (ppid === process.child.pid) ownedPids.add(pid)
            }
            controller.abort()
          }
        })
      }
      return process
    }
    try {
      await assert.rejects(service.repairPreview(previewGrant.grant, strokes, AbortSignal.any([controller.signal, AbortSignal.timeout(60_000)])))
      assert.ok(inferenceStarted, 'preview must reach real inference before cancellation')
    } finally { Processes.prototype.start = originalStart; controller.abort() }
    for (const directory of previewWork) await assert.rejects(stat(directory), { code: 'ENOENT' })
    // All supervised processes, including the native runner observed above, must exit.
    for (const pid of ownedPids) assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' })
    report.cases.push({ label: `repeat-${cycle}-inference-cancel`, inferenceStarted, reapedProcesses: ownedPids.size, previewCleaned: true })
    await runCase(`repeat-${cycle}-repair`, 512, 512, { repair: true })
    const statuses = service.list().map(({ id, status }) => ({ id, status }))
    await service.close(); service = new UpscaleService(db)
    assert.deepEqual(service.list().map(({ id, status }) => ({ id, status })), statuses)
    assert.ok(!(await readdir(root)).some((name) => name.startsWith('.mediagrab-upscale-')))
    report.cases.push({ label: `repeat-${cycle}-restart-cleanup`, passed: true, coreRssBytes: process.memoryUsage().rss })
  }
  const stress = process.env.UPSCALER_IMAGE_STRESS === '1'
  if (stress) for (const [width, height] of [[1600, 1250], [2000, 2000], [4000, 2000]]) await runCase(`stress-${width * height}`, width, height, { repair: true })
  await service.close()
  assert.ok(!(await readdir(root)).some((name) => name.startsWith('.mediagrab-upscale-')))
  report.source = 'locally generated synthetic fixtures; not a real-photo quality or low-memory pressure result'
  const directory = path.resolve('artifacts/upscale-image-regression')
  await mkdir(directory, { recursive: true })
  const output = path.join(directory, `report-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
  await writeFile(output, JSON.stringify(report, null, 2) + '\n'); console.log(`Report: ${output}`)
} finally {
  await service.close(); db.close(); await rm(root, { recursive: true, force: true })
}
