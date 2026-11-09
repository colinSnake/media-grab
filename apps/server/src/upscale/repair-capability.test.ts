import { createHash } from 'node:crypto'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const fixture = vi.hoisted(() => ({ runtimeFails: false }))
vi.mock('./process.js', () => ({ Processes: class {
  async run() { if (fixture.runtimeFails) throw new Error('native binding unavailable'); return '' }
  async settle() {}
} }))
import { checkRepairRuntime, repairCapability, verifyRepairModel } from './repair-capability.js'
let root: string
beforeEach(async () => { root = await mkdtemp(path.join(os.tmpdir(), 'repair-capability-')); fixture.runtimeFails = false })
afterEach(async () => { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }) })
const signal = () => new AbortController().signal
it('streams hash verification and rejects changed contents or truncated weights', async () => {
  const file = path.join(root, 'model.onnx'), bytes = Buffer.alloc(1024 * 1024, 7)
  const expected = { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
  await writeFile(file, bytes); await expect(verifyRepairModel(file, signal(), expected)).resolves.toBeUndefined()
  bytes[0] = 8; await writeFile(file, bytes)
  await expect(verifyRepairModel(file, signal(), expected)).rejects.toThrow('SHA-256')
  await writeFile(file, 'truncated'); await expect(verifyRepairModel(file, signal(), expected)).rejects.toThrow('大小不匹配')
})
it('reports missing model without disabling ordinary upscale or loading weights', async () => {
  vi.stubEnv('MEDIAGRAB_INPAINT_MODEL', path.join(root, 'missing.onnx'))
  expect(await repairCapability(signal())).toMatchObject({ repairAvailable: false, repairReason: expect.stringContaining('未安装') })
})
it('rejects unreadable model files even under a privileged runner', async () => {
  const file = path.join(root, 'unreadable'); await writeFile(file, 'x'); await chmod(file, 0o000)
  try { await expect(verifyRepairModel(file, signal())).rejects.toThrow('可读') } finally { await chmod(file, 0o600) }
})
it('honors cancellation before opening a large model', async () => {
  const abort = new AbortController(); abort.abort()
  await expect(verifyRepairModel(path.join(root, 'absent'), abort.signal)).rejects.toMatchObject({ name: 'AbortError' })
})

it('isolates native binding failures and reports an actionable runtime error', async () => {
  fixture.runtimeFails = true
  await expect(checkRepairRuntime(signal())).rejects.toThrow('原生运行时不可用')
})
