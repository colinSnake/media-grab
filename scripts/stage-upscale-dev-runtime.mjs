import { access, cp, lstat, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const source = path.resolve(process.env.UPSCALER_DEVELOPMENT_SOURCE_DIR?.trim() || path.join(root, '.release-tools/upscale-offline-test'))
const destination = path.join(root, 'apps/desktop/src-tauri/resources/media-tools/darwin-arm64/upscale')
const args = process.argv.slice(2)
const replaceDevelopment = args.includes('--replace-development')
if (args.some((argument) => argument !== '--replace-development') || (replaceDevelopment && !process.env.UPSCALER_DEVELOPMENT_SOURCE_DIR)) {
  throw new Error('Usage: node scripts/stage-upscale-dev-runtime.mjs [--replace-development] (替换时必须显式设置 UPSCALER_DEVELOPMENT_SOURCE_DIR)')
}
if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('本机超分测试资源只支持 macOS Apple Silicon')
const manifest = JSON.parse(await readFile(path.join(source, 'manifest.json'), 'utf8'))
if (manifest.target !== 'darwin-arm64' || manifest.developmentOnly !== true) throw new Error('只接受标记为 developmentOnly 的 darwin-arm64 测试资源')
for (const [name, expected] of Object.entries(manifest.files)) {
  const file = path.join(source, name)
  const bytes = await readFile(file)
  if (createHash('sha256').update(bytes).digest('hex') !== expected) throw new Error(`本机测试资源哈希不匹配: ${name}`)
  if (!name.startsWith('models/')) await access(file)
}
if (replaceDevelopment) {
  const existing = JSON.parse(await readFile(path.join(destination, 'manifest.json'), 'utf8'))
  if (existing.target !== 'darwin-arm64' || existing.developmentOnly !== true) throw new Error('只允许替换标记为 developmentOnly 的本机资源')
  for (const name of ['realesrgan-ncnn-vulkan', `models/${manifest.model}.bin`, `models/${manifest.model}.param`]) {
    if (existing.files?.[name] !== manifest.files?.[name]) throw new Error(`替换会改变既有超分引擎/模型，拒绝继续: ${name}`)
  }
  for (const name of ['ffmpeg', 'ffprobe']) {
    const temporary = `${path.join(destination, name)}.new-${process.pid}`
    await cp(path.join(source, name), temporary)
    await rename(temporary, path.join(destination, name))
  }
  await writeFile(path.join(destination, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  console.log(`已更新本机 developmentOnly FFmpeg/FFprobe，保留原有超分引擎及模型: ${path.relative(root, destination)}`)
} else {
  try { await lstat(destination); throw new Error(`目标目录已存在，拒绝覆盖: ${destination}`) }
  catch (error) { if (error.code !== 'ENOENT') throw error }
  await mkdir(path.dirname(destination), { recursive: true })
  await cp(source, destination, { recursive: true, errorOnExist: true, force: false })
  console.log(`已暂存本机 developmentOnly 超分资源: ${path.relative(root, destination)}`)
}
