/** Explicit, offline staging only. Never downloads models or touches a reference project. */
import { lstat, chmod, copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { systemDylibsOnly } from './build-upscale-ffmpeg.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2).filter((arg) => arg !== '--')
if (args.length > 1 || args.some((arg) => arg !== '--development')) throw new Error('Usage: prepare:upscale-tools [--development]')
const development = args.includes('--development')
if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('Only darwin-arm64 is supported')
for (const name of ['UPSCALER_SOURCE_DIR', 'UPSCALER_FFMPEG', 'UPSCALER_FFPROBE']) {
  if (!process.env[name] || !path.isAbsolute(process.env[name])) throw new Error(`Set explicit absolute ${name}`)
}
const source = process.env.UPSCALER_SOURCE_DIR
const developmentDestination = process.env.UPSCALER_DEVELOPMENT_DESTINATION
if (developmentDestination && (!development || !path.isAbsolute(developmentDestination) || !path.resolve(developmentDestination).startsWith(path.join(root, '.release-tools') + path.sep))) throw new Error('Development destination must be an explicit path under this repository .release-tools')
const destination = development ? developmentDestination ?? path.join(root, '.release-tools', 'upscale-dev') : path.join(root, 'apps/desktop/src-tauri/resources/media-tools/darwin-arm64/upscale')
// Refuse replacement, including a partial staging directory left by an earlier failure.
try { await lstat(destination); throw new Error('Staging already exists; do not silently replace runtime inputs') } catch (error) { if (error.code !== 'ENOENT') throw error }
const inputs = {
  ffmpeg: process.env.UPSCALER_FFMPEG,
  ffprobe: process.env.UPSCALER_FFPROBE,
  'realesrgan-ncnn-vulkan': path.join(source, 'realesrgan-ncnn-vulkan'),
  'models/realesr-animevideov3-x2.bin': path.join(source, 'models/realesr-animevideov3-x2.bin'),
  'models/realesr-animevideov3-x2.param': path.join(source, 'models/realesr-animevideov3-x2.param'),
}
const notices = ['Real-ESRGAN-LICENSE.txt', 'Real-ESRGAN-ncnn-vulkan-LICENSE.txt', 'FFmpeg-LICENSE.txt', 'x264-LICENSE.txt', 'FFmpeg-SOURCE-NOTICE.txt', 'THIRD_PARTY_NOTICES.txt']
let review
if (!development) {
  for (const key of ['UPSCALER_LICENSE_DIR', 'UPSCALER_REVIEW_MANIFEST']) if (!path.isAbsolute(process.env[key] ?? '')) throw new Error(`Release staging requires absolute ${key}`)
  review = JSON.parse(await readFile(process.env.UPSCALER_REVIEW_MANIFEST, 'utf8'))
  const reviewedInputs = Object.keys(inputs)
  if (
    !review || review.schemaVersion !== 1 || review.redistributionReviewed !== true
    || review.target !== 'darwin-arm64' || review.decision !== 'approved'
    || typeof review.reviewedBy !== 'string' || !review.reviewedBy.trim()
    || typeof review.reviewedAt !== 'string' || !Number.isFinite(Date.parse(review.reviewedAt))
    || !Array.isArray(review.evidence) || !review.evidence.length
    || review.evidence.some((item) => typeof item !== 'string' || !item.trim())
    || ['engineSource', 'modelSource', 'ffmpegSource', 'ffprobeSource'].some((key) => typeof review[key] !== 'string' || !review[key].trim())
    || reviewedInputs.some((name) => !/^[a-f0-9]{64}$/.test(review.files?.[name] ?? ''))
  ) throw new Error('Incomplete provenance / redistribution review manifest')
}
const sourceHashes = {}, versions = {}, sources = {}, noticeData = {}
// Validate ALL inputs before executing an input binary or creating a runtime directory.
for (const [name, file] of Object.entries(inputs)) {
  if ((await stat(file)).size > 256 * 1024 ** 2) throw new Error(`Unexpected dependency size: ${name}`)
  sourceHashes[name] = createHash('sha256').update(await readFile(file)).digest('hex')
  if (review && review.files?.[name] !== sourceHashes[name]) throw new Error(`Unreviewed input SHA-256: ${name}`)
  if (!name.startsWith('models/')) {
    const arch = execFileSync('/usr/bin/lipo', ['-archs', file], { encoding: 'utf8' })
    if (!arch.split(/\s+/).includes('arm64')) throw new Error(`Wrong architecture: ${name}`)
    if (!development) systemDylibsOnly(execFileSync('/usr/bin/otool', ['-L', file], { encoding: 'utf8' }))
  }
}
if (!development) for (const name of notices) {
  const data = await readFile(path.join(process.env.UPSCALER_LICENSE_DIR, name))
  if (!data.length || data.length > 1024 ** 2) throw new Error(`Missing/oversized notice: ${name}`)
  noticeData[name] = data
}
for (const [name, file] of Object.entries(inputs)) if (!name.startsWith('models/')) {
  versions[name] = name === 'realesrgan-ncnn-vulkan' ? '20220424 / v0.2.5.0 (binary SHA-256 pinned)' : execFileSync(file, ['-version'], { encoding: 'utf8', timeout: 15000 }).split('\n')[0]
}
await mkdir(path.dirname(destination), { recursive: true })
await mkdir(destination, { mode: 0o700 }) // exclusive ownership; never modify an existing directory
const files = {}
for (const [name, file] of Object.entries(inputs)) {
  const target = path.join(destination, name)
  await mkdir(path.dirname(target), { recursive: true })
  await copyFile(file, target)
  if (createHash('sha256').update(await readFile(target)).digest('hex') !== sourceHashes[name]) throw new Error(`Source changed during staging: ${name}`)
  if (!name.startsWith('models/')) await chmod(target, 0o755)
  if (!name.startsWith('models/') && process.env.UPSCALER_SIGN_IDENTITY) execFileSync('/usr/bin/codesign', ['--force', '--sign', process.env.UPSCALER_SIGN_IDENTITY, target], { stdio: 'inherit', timeout: 30000 })
  files[name] = createHash('sha256').update(await readFile(target)).digest('hex')
  sources[name] = development ? file : path.basename(file)
}
for (const [name, data] of Object.entries(noticeData)) {
  await writeFile(path.join(destination, name), data, { flag: 'wx' })
  files[name] = createHash('sha256').update(data).digest('hex')
}
if (!development) {
  const provenance = JSON.stringify(review, null, 2) + '\n'
  await writeFile(path.join(destination, 'provenance.json'), provenance, { flag: 'wx' })
  files['provenance.json'] = createHash('sha256').update(provenance).digest('hex')
}
const manifest = { redistributionReviewed: !development, target: 'darwin-arm64', model: 'realesr-animevideov3-x2', developmentOnly: development, files, versions, sources, createdAt: new Date().toISOString() }
await writeFile(path.join(destination, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' })
console.log(JSON.stringify({ directory: destination, ...manifest }, null, 2))
