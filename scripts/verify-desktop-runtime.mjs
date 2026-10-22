import { execFile } from 'node:child_process'
import { readlink, readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

const execFileAsync = promisify(execFile)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const runtimeDir = path.join(root, 'apps', 'desktop', 'src-tauri', 'resources', 'core')
const toolsDir = path.join(root, 'apps', 'desktop', 'src-tauri', 'resources', 'media-tools', `${process.platform}-${process.arch}`)
const nodeName = process.platform === 'win32' ? 'node.exe' : 'node'
const toolSuffix = process.platform === 'win32' ? '.exe' : ''

async function mustBeFile(file, label) {
  const info = await stat(file).catch(() => undefined)
  if (info?.isFile() !== true) throw new Error(`${label} 不存在: ${file}`)
}

async function directorySize(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  let total = 0
  for (const entry of entries) {
    const file = path.join(directory, entry.name)
    total += entry.isDirectory() ? await directorySize(file) : (await stat(file)).size
  }
  return total
}

async function checkNoAbsoluteSymlinks(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  for (const entry of entries) {
    const file = path.join(directory, entry.name)
    if (entry.isSymbolicLink()) {
      const target = await readlink(file)
      if (path.isAbsolute(target)) throw new Error(`runtime 含有绝对 symlink: ${file} -> ${target}`)
    } else if (entry.isDirectory()) {
      await checkNoAbsoluteSymlinks(file)
    }
  }
}

await mustBeFile(path.join(runtimeDir, nodeName), 'Node runtime')
await mustBeFile(path.join(runtimeDir, 'dist', 'index.js'), 'server entry')
await mustBeFile(path.join(runtimeDir, 'web', 'index.html'), 'web entry')
await mustBeFile(path.join(runtimeDir, 'node_modules', '@mediagrab', 'shared', 'dist', 'index.js'), 'shared runtime')
await checkNoAbsoluteSymlinks(runtimeDir)

const forbidden = ['src', 'scripts', 'download']
for (const name of forbidden) {
  if (await stat(path.join(runtimeDir, name)).then(() => true).catch(() => false)) {
    throw new Error(`runtime 不应包含开发目录: ${name}`)
  }
}

const runtimeBytes = await directorySize(runtimeDir)
const runtimeLimit = Number(process.env.MEDIA_GRAB_RUNTIME_LIMIT_MB ?? 180) * 1024 * 1024
if (runtimeBytes > runtimeLimit) {
  throw new Error(`Node core 体积 ${(runtimeBytes / 1024 / 1024).toFixed(1)} MiB 超过上限 ${(runtimeLimit / 1024 / 1024).toFixed(0)} MiB`)
}

await mustBeFile(path.join(toolsDir, `ffmpeg${toolSuffix}`), 'bundled FFmpeg')
await mustBeFile(path.join(toolsDir, `yt-dlp${toolSuffix}`), 'bundled yt-dlp')
const toolsBytes = await directorySize(toolsDir)
const toolsLimit = Number(process.env.MEDIA_GRAB_TOOLS_LIMIT_MB ?? 180) * 1024 * 1024
if (toolsBytes > toolsLimit) {
  throw new Error(`媒体工具体积 ${(toolsBytes / 1024 / 1024).toFixed(1)} MiB 超过上限 ${(toolsLimit / 1024 / 1024).toFixed(0)} MiB`)
}

const [ffmpeg, ytdlp] = await Promise.all([
  execFileAsync(path.join(toolsDir, `ffmpeg${toolSuffix}`), ['-version'], { timeout: 10_000 }),
  execFileAsync(path.join(toolsDir, `yt-dlp${toolSuffix}`), ['--version'], { timeout: 10_000 }),
])
if (!/^ffmpeg version\s/i.test(ffmpeg.stdout)) throw new Error('内置 FFmpeg 没有返回可识别的版本信息。')
if (!/^\d+\.\d+(?:\.\d+)?(?:$|\s)/.test(ytdlp.stdout.trim())) throw new Error('内置 yt-dlp 没有返回可识别的版本信息。')
console.log(JSON.stringify({
  target: `${process.platform}-${process.arch}`,
  runtimeMiB: Number((runtimeBytes / 1024 / 1024).toFixed(1)),
  toolsMiB: Number((toolsBytes / 1024 / 1024).toFixed(1)),
  ffmpeg: ffmpeg.stdout.split('\n', 1)[0]?.trim() ?? '',
  ytDlp: ytdlp.stdout.trim(),
}, null, 2))
