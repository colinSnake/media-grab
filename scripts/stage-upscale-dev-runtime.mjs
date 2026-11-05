import { access, cp, lstat, mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const source = path.join(root, '.release-tools/upscale-offline-test')
const destination = path.join(root, 'apps/desktop/src-tauri/resources/media-tools/darwin-arm64/upscale')
if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('本机超分测试资源只支持 macOS Apple Silicon')
const manifest = JSON.parse(await readFile(path.join(source, 'manifest.json'), 'utf8'))
if (manifest.target !== 'darwin-arm64' || manifest.developmentOnly !== true) throw new Error('只接受标记为 developmentOnly 的 darwin-arm64 测试资源')
for (const [name, expected] of Object.entries(manifest.files)) {
  const file = path.join(source, name)
  const bytes = await readFile(file)
  if (createHash('sha256').update(bytes).digest('hex') !== expected) throw new Error(`本机测试资源哈希不匹配: ${name}`)
  if (!name.startsWith('models/')) await access(file)
}
try { await lstat(destination); throw new Error(`目标目录已存在，拒绝覆盖: ${destination}`) }
catch (error) { if (error.code !== 'ENOENT') throw error }
await mkdir(path.dirname(destination), { recursive: true })
await cp(source, destination, { recursive: true, errorOnExist: true, force: false })
console.log(`已暂存本机 developmentOnly 超分资源: ${path.relative(root, destination)}`)
