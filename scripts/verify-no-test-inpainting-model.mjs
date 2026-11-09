import { access } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const model = path.join(root, 'apps/desktop/src-tauri/resources/inpainting/lama.onnx')
try {
  await access(model)
  throw new Error('发行构建禁止包含未经审查的本地 LaMa 测试模型，请移除 resources/inpainting/lama.onnx 后重试。')
} catch (error) {
  if (error.code !== 'ENOENT') throw error
}
console.log('No local test inpainting model staged.')
