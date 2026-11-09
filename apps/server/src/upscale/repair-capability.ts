import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Processes } from './process.js'

export const repairModel = { bytes: 208044816, sha256: '1faef5301d78db7dda502fe59966957ec4b79dd64e16f03ed96913c7a4eb68d6' } as const
export const repairModelPath = () => process.env.MEDIAGRAB_INPAINT_MODEL?.trim() || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../.release-tools/watermark-inpainting/lama.onnx')

export async function verifyRepairModel(file: string, signal: AbortSignal, expected: { bytes: number; sha256: string } = repairModel): Promise<void> {
  signal.throwIfAborted()
  const info = await stat(file).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') throw new Error('未安装图片修补模型；普通图片/视频超分仍可使用')
    throw new Error('图片修补模型不可读，请检查文件权限', { cause: error })
  })
  if (!info.isFile() || !(info.mode & 0o444)) throw new Error('图片修补模型不是可读的普通文件')
  if (info.size !== expected.bytes) throw new Error('图片修补模型大小不匹配，请重新安装正确模型')
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file, { signal })) hash.update(chunk)
  if (hash.digest('hex') !== expected.sha256) throw new Error('图片修补模型 SHA-256 校验失败，请重新安装正确模型')
}

/** Probe native bindings in an owned child, without loading weights in the core. */
export async function repairCapability(signal: AbortSignal): Promise<{ repairAvailable: boolean; repairReason?: string }> {
  try {
    await verifyRepairModel(repairModelPath(), signal)
    await checkRepairRuntime(signal)
    return { repairAvailable: true }
  } catch (error) {
    return { repairAvailable: false, repairReason: error instanceof Error ? error.message : '图片修补运行时不可用' }
  }
}

export async function checkRepairRuntime(signal: AbortSignal): Promise<void> {
  const processes = new Processes(signal)
  try {
    const runner = fileURLToPath(new URL('./inpainting-runner.mjs', import.meta.url))
    await processes.run(process.execPath, [runner, '--check-runtime'], 4096, { timeoutMs: 10_000 })
  } catch (error) {
    throw new Error('图片修补原生运行时不可用，请重新安装当前平台的应用', { cause: error })
  } finally { await processes.settle() }
}
