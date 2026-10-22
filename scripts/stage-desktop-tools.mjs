import { chmod, cp, mkdir, readdir, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const source = process.env.MEDIA_TOOLS_SOURCE_DIR?.trim()
const target = `${process.platform}-${process.arch}`
const destination = path.join(root, 'apps', 'desktop', 'src-tauri', 'resources', 'media-tools', target)

if (!source) {
  throw new Error('请设置 MEDIA_TOOLS_SOURCE_DIR，指向包含 ffmpeg 和 yt-dlp 二进制文件的目录。')
}

const sourceRoot = path.resolve(source)
const targetSource = path.join(sourceRoot, target)
const inputDir = existsSync(targetSource) ? targetSource : sourceRoot
const names = process.platform === 'win32'
  ? { ffmpeg: ['ffmpeg.exe', 'ffmpeg'], ytdlp: ['yt-dlp.exe', 'yt-dlp'] }
  : { ffmpeg: ['ffmpeg'], ytdlp: ['yt-dlp'] }

async function findTool(candidates) {
  const entries = new Set(await readdir(inputDir))
  const match = candidates.find((candidate) => entries.has(candidate))
  if (match === undefined) throw new Error(`在 ${inputDir} 中未找到 ${candidates[0]}。`)
  return path.join(inputDir, match)
}

await mkdir(destination, { recursive: true })
await rm(path.join(destination, 'ffmpeg'), { force: true })
await rm(path.join(destination, 'ffmpeg.exe'), { force: true })
await rm(path.join(destination, 'yt-dlp'), { force: true })
await rm(path.join(destination, 'yt-dlp.exe'), { force: true })

const ffmpegSource = await findTool(names.ffmpeg)
const ytdlpSource = await findTool(names.ytdlp)
const ffmpegName = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'
const ytdlpName = process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp'
await cp(ffmpegSource, path.join(destination, ffmpegName))
await cp(ytdlpSource, path.join(destination, ytdlpName))

if (process.platform !== 'win32') {
  await chmod(path.join(destination, ffmpegName), 0o755)
  await chmod(path.join(destination, ytdlpName), 0o755)
}

console.log(`已暂存 ${target} 的 FFmpeg 和 yt-dlp：${path.relative(root, destination)}`)
