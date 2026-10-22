import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { chmod, copyFile, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { pipeline } from 'node:stream/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

const execFileAsync = promisify(execFile)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const target = `${process.platform}-${process.arch}`
const inputDirectory = process.env.MEDIA_GRAB_RELEASE_INPUTS_DIR?.trim()
  ? path.resolve(process.env.MEDIA_GRAB_RELEASE_INPUTS_DIR)
  : path.join(root, '.release-tools', target)
const inputConfig = path.join(inputDirectory, 'release-inputs.json')
const savedInputs = await readFile(inputConfig, 'utf8').then(JSON.parse).catch((error) => {
  if (error.code === 'ENOENT') return {}
  throw error
})
for (const [name, value] of Object.entries(savedInputs)) {
  if (typeof value !== 'string') throw new Error(`本地工具配置 ${name} 必须为字符串。`)
  if (!process.env[name]) {
    process.env[name] = /_(?:BIN|LICENSE_FILE)$/.test(name) ? path.resolve(inputDirectory, value) : value
  }
}
const targetRoot = process.env.MEDIA_TOOLS_OUTPUT_DIR?.trim()
  ? path.resolve(process.env.MEDIA_TOOLS_OUTPUT_DIR)
  : path.join(root, 'apps', 'desktop', 'src-tauri', 'resources', 'media-tools')
const destination = path.join(targetRoot, target)
const ytDlpVersion = process.env.YT_DLP_VERSION?.trim()
const ytDlpSha256 = process.env.YT_DLP_SHA256?.trim().toLowerCase()
const ytDlpUrl = process.env.YT_DLP_URL?.trim()
const ytDlpBin = process.env.YT_DLP_BIN?.trim()
const ytDlpLicense = process.env.YT_DLP_LICENSE_FILE?.trim()
const ffmpegVersion = process.env.FFMPEG_VERSION?.trim()
const ffmpegSha256 = process.env.FFMPEG_SHA256?.trim().toLowerCase()
const ffmpegUrl = process.env.FFMPEG_URL?.trim()
const ffmpegBin = process.env.FFMPEG_BIN?.trim()
const ffmpegLicense = process.env.FFMPEG_LICENSE_FILE?.trim()
const lameLicense = process.env.LAME_LICENSE_FILE?.trim()
const ytDlpThirdPartyLicense = process.env.YT_DLP_THIRD_PARTY_LICENSE_FILE?.trim()
const suffix = process.platform === 'win32' ? '.exe' : ''
const ytDlpName = `yt-dlp${suffix}`
const ffmpegName = `ffmpeg${suffix}`
const maxYtDlpBytes = Number(process.env.YT_DLP_MAX_SIZE_MB ?? 60) * 1024 * 1024
const maxFfmpegBytes = Number(process.env.FFMPEG_MAX_SIZE_MB ?? 100) * 1024 * 1024

function required(name, value) {
  if (!value) throw new Error(`${name} 必须设置。`)
}

for (const [name, value] of Object.entries({
  YT_DLP_VERSION: ytDlpVersion,
  YT_DLP_SHA256: ytDlpSha256,
  YT_DLP_LICENSE_FILE: ytDlpLicense,
  FFMPEG_VERSION: ffmpegVersion,
  FFMPEG_SHA256: ffmpegSha256,
  FFMPEG_LICENSE_FILE: ffmpegLicense,
  LAME_LICENSE_FILE: lameLicense,
  YT_DLP_THIRD_PARTY_LICENSE_FILE: ytDlpThirdPartyLicense,
})) required(name, value)

if (!ytDlpUrl && !ytDlpBin) throw new Error('YT_DLP_URL 或 YT_DLP_BIN 必须设置。')
if (ytDlpUrl && ytDlpBin) throw new Error('YT_DLP_URL 和 YT_DLP_BIN 只能设置一个。')
if (!ffmpegUrl && !ffmpegBin) throw new Error('FFMPEG_URL 或 FFMPEG_BIN 必须设置。')
if (ffmpegUrl && ffmpegBin) throw new Error('FFMPEG_URL 和 FFMPEG_BIN 只能设置一个。')
if (ytDlpUrl && !ytDlpUrl.includes(ytDlpVersion)) throw new Error('YT_DLP_URL 必须包含固定版本号。')
for (const [name, value] of [['YT_DLP_SHA256', ytDlpSha256], ['FFMPEG_SHA256', ffmpegSha256]]) {
  if (!/^[a-f0-9]{64}$/.test(value)) throw new Error(`${name} 必须是 64 位 SHA-256。`)
}

const temporaryDir = await mkdtemp(path.join(os.tmpdir(), 'mediagrab-release-tools-'))

async function sha256(file) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}

async function stageInput(label, url, sourceFile, expectedHash, maxBytes) {
  const staged = path.join(temporaryDir, `${label}${suffix}`)
  if (sourceFile) {
    await copyFile(path.resolve(sourceFile), staged)
  } else {
    const response = await fetch(url, { redirect: 'follow' })
    if (!response.ok || response.body === null) throw new Error(`${label} 下载失败: HTTP ${response.status}`)
    let downloadedBytes = 0
    const limit = new TransformStream({
      transform(chunk, controller) {
        downloadedBytes += chunk.byteLength
        if (downloadedBytes > maxBytes) throw new Error(`${label} 超过 ${(maxBytes / 1024 / 1024).toFixed(0)} MiB 体积上限。`)
        controller.enqueue(chunk)
      },
    })
    await pipeline(response.body, limit, createWriteStream(staged))
  }
  const size = (await stat(staged)).size
  if (size === 0 || size > maxBytes) throw new Error(`${label} 大小无效: ${(size / 1024 / 1024).toFixed(1)} MiB`)
  const actualHash = await sha256(staged)
  if (actualHash !== expectedHash) throw new Error(`${label} SHA-256 不匹配: ${actualHash}`)
  if (process.platform !== 'win32') await chmod(staged, 0o755)
  return { path: staged, size, sha256: actualHash }
}

async function binaryOutput(file, args) {
  const result = await execFileAsync(file, args, { timeout: 60_000, maxBuffer: 2 * 1024 * 1024 })
  return `${result.stdout}\n${result.stderr}`
}

try {
  const [ytDlp, ffmpeg] = await Promise.all([
    stageInput('yt-dlp', ytDlpUrl, ytDlpBin, ytDlpSha256, maxYtDlpBytes),
    stageInput('ffmpeg', ffmpegUrl, ffmpegBin, ffmpegSha256, maxFfmpegBytes),
  ])
  const [ytDlpActualVersion, ffmpegVersionOutput, ffmpegBuildconf, ffmpegEncoders] = await Promise.all([
    binaryOutput(ytDlp.path, ['--version']),
    binaryOutput(ffmpeg.path, ['-version']),
    binaryOutput(ffmpeg.path, ['-buildconf']),
    binaryOutput(ffmpeg.path, ['-hide_banner', '-encoders']),
  ])
  if (ytDlpActualVersion.trim() !== ytDlpVersion) {
    throw new Error(`yt-dlp 版本不匹配: 期望 ${ytDlpVersion}，实际 ${ytDlpActualVersion.trim()}`)
  }
  if (!ffmpegVersionOutput.includes(`ffmpeg version ${ffmpegVersion}`)) {
    throw new Error(`FFmpeg 版本不匹配，期望输出包含 ffmpeg version ${ffmpegVersion}`)
  }
  if (/--enable-(?:gpl|nonfree)\b/i.test(ffmpegBuildconf)) {
    throw new Error('FFmpeg 构建启用了 GPL 或 nonfree 组件；拒绝放入默认发行包。')
  }
  if (!/\blibmp3lame\b/.test(ffmpegEncoders)) {
    throw new Error('FFmpeg 缺少 libmp3lame 编码器，无法满足 MP3 导出功能。')
  }

  const licenseFiles = [
    { source: path.resolve(ytDlpLicense), name: 'yt-dlp-LICENSE.txt' },
    { source: path.resolve(ffmpegLicense), name: 'ffmpeg-LICENSE.txt' },
    { source: path.resolve(lameLicense), name: 'lame-LICENSE.txt' },
    { source: path.resolve(ytDlpThirdPartyLicense), name: 'yt-dlp-THIRD_PARTY_LICENSES.txt' },
  ]
  for (const license of licenseFiles) {
    const content = await readFile(license.source)
    if (content.length < 256) throw new Error(`${license.name} 许可证文件内容过短。`)
  }

  await mkdir(destination, { recursive: true })
  const stagedOutputs = [
    { source: ytDlp.path, name: ytDlpName },
    { source: ffmpeg.path, name: ffmpegName },
    ...licenseFiles.map(({ source, name }) => ({ source, name })),
  ]
  for (const item of stagedOutputs) {
    const temporaryOutput = path.join(destination, `.${item.name}.tmp`)
    await copyFile(item.source, temporaryOutput)
    if (item.name === ytDlpName || item.name === ffmpegName) {
      if (process.platform !== 'win32') await chmod(temporaryOutput, 0o755)
    }
    await rename(temporaryOutput, path.join(destination, item.name))
  }

  const manifest = {
    target,
    ytDlp: { version: ytDlpVersion, sha256: ytDlp.sha256, sizeBytes: ytDlp.size, license: 'Unlicense source; bundled dependencies have separate licenses; see included notices' },
    ffmpeg: { version: ffmpegVersion, sha256: ffmpeg.sha256, sizeBytes: ffmpeg.size, license: 'LGPL-compatible build; see included notice' },
  }
  await writeFile(path.join(destination, 'tools-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  console.log(JSON.stringify({ target, ytDlpMiB: Number((ytDlp.size / 1024 / 1024).toFixed(1)), ffmpegMiB: Number((ffmpeg.size / 1024 / 1024).toFixed(1)), ffmpegVersion, ytDlpVersion }, null, 2))
} finally {
  await rm(temporaryDir, { recursive: true, force: true })
}
