import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { chmod, mkdir, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const target = `${process.platform}-${process.arch}`
const destination = path.join(root, 'apps', 'desktop', 'src-tauri', 'resources', 'media-tools', target)
const ytDlpVersion = process.env.YT_DLP_VERSION?.trim()
const ytDlpSha256 = process.env.YT_DLP_SHA256?.trim().toLowerCase()
const ytDlpUrl = process.env.YT_DLP_URL?.trim()
const ffmpegSha256 = process.env.FFMPEG_SHA256?.trim().toLowerCase()
const ffmpegUrl = process.env.FFMPEG_URL?.trim()

for (const [name, value] of Object.entries({ YT_DLP_VERSION: ytDlpVersion, YT_DLP_SHA256: ytDlpSha256, YT_DLP_URL: ytDlpUrl, FFMPEG_SHA256: ffmpegSha256, FFMPEG_URL: ffmpegUrl })) {
  if (!value) throw new Error(`${name} 必须在目标平台的 release runner 中设置。`)
}
if (!ytDlpUrl.includes(ytDlpVersion)) throw new Error('YT_DLP_URL 必须包含与 YT_DLP_VERSION 一致的固定版本号。')
for (const [name, value] of [['YT_DLP_SHA256', ytDlpSha256], ['FFMPEG_SHA256', ffmpegSha256]]) {
  if (!/^[a-f0-9]{64}$/.test(value)) throw new Error(`${name} 必须是 64 位 SHA-256。`)
}

await mkdir(destination, { recursive: true })
const temporaryDir = await import('node:fs/promises').then(({ mkdtemp }) => mkdtemp(path.join(os.tmpdir(), 'mediagrab-tools-')))

async function downloadAndVerify(label, url, expectedHash, output) {
  const response = await fetch(url, { redirect: 'follow' })
  if (!response.ok || response.body === null) throw new Error(`${label} 下载失败: HTTP ${response.status}`)
  const temporaryFile = path.join(temporaryDir, label)
  await pipeline(response.body, createWriteStream(temporaryFile))
  const hash = createHash('sha256').update(await import('node:fs/promises').then(({ readFile }) => readFile(temporaryFile))).digest('hex')
  if (hash !== expectedHash) throw new Error(`${label} SHA-256 不匹配: ${hash}`)
  await rm(output, { force: true })
  await import('node:fs/promises').then(({ copyFile }) => copyFile(temporaryFile, output))
}

try {
  const executableSuffix = process.platform === 'win32' ? '.exe' : ''
  const ytDlpName = `yt-dlp${executableSuffix}`
  const ffmpegName = `ffmpeg${executableSuffix}`
  await downloadAndVerify('yt-dlp', ytDlpUrl, ytDlpSha256, path.join(destination, ytDlpName))
  await downloadAndVerify('ffmpeg', ffmpegUrl, ffmpegSha256, path.join(destination, ffmpegName))
  if (process.platform !== 'win32') {
    await chmod(path.join(destination, ytDlpName), 0o755)
    await chmod(path.join(destination, ffmpegName), 0o755)
  }
  console.log(`已校验并准备 ${target} 工具（yt-dlp ${ytDlpVersion}）`)
} finally {
  await rm(temporaryDir, { recursive: true, force: true })
}
