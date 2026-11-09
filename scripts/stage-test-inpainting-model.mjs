import { chmod, copyFile, mkdir, readFile, stat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
if (process.env.MEDIAGRAB_ALLOW_DEVELOPMENT_UPSCALE !== '1') {
  throw new Error('测试模型仅可用于明确标记的本地构建：设置 MEDIAGRAB_ALLOW_DEVELOPMENT_UPSCALE=1')
}
const source = path.join(root, '.release-tools/watermark-inpainting/lama.onnx')
const destination = path.join(root, 'apps/desktop/src-tauri/resources/inpainting/lama.onnx')
const expectedHash = '1faef5301d78db7dda502fe59966957ec4b79dd64e16f03ed96913c7a4eb68d6'
const data = await readFile(source)
if (data.length !== 208044816 || createHash('sha256').update(data).digest('hex') !== expectedHash) {
  throw new Error('本地 LaMa 模型的大小或 SHA-256 与已记录测试模型不匹配')
}
await mkdir(path.dirname(destination), { recursive: true })
try {
  const existing = await readFile(destination)
  if (createHash('sha256').update(existing).digest('hex') !== expectedHash) {
    throw new Error(`拒绝覆盖不同的现有模型资源: ${destination}`)
  }
  console.log(`已验证测试模型资源: ${path.relative(root, destination)} (${(await stat(destination)).size} bytes)`)
} catch (error) {
  if (error.code !== 'ENOENT') throw error
  await copyFile(source, destination)
  await chmod(destination, 0o644)
  console.log(`已暂存仅供本地测试的模型: ${path.relative(root, destination)} (${data.length} bytes)`)
}
