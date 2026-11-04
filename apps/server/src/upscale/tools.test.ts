import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { chmod, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
const control = vi.hoisted(() => ({ arch: 'arm64' }))
vi.mock('./process.js', () => ({ Processes: class {
  async run(file: string, args: string[]): Promise<string> { if (args.some((a) => ['-encoders', '-decoders', '-demuxers'].includes(a))) return 'libx264 png h264 aac mov image2pipe'; return file === '/usr/bin/lipo' ? control.arch : 'fixture-version' }
} }))
import { capability, model, sha256 } from './tools.js'
let root: string
beforeEach(async () => { root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'upscale-tools-'))); vi.stubEnv('MEDIAGRAB_UPSCALE_DIR', root); control.arch = 'arm64' })
afterEach(async () => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); await rm(root, { recursive: true, force: true }) })
async function fixture() {
  await mkdir(path.join(root, 'models'))
  const files: Record<string, string> = {}, versions: Record<string, string> = {}
  for (const name of ['ffmpeg', 'ffprobe', 'realesrgan-ncnn-vulkan', `models/${model}.bin`, `models/${model}.param`]) {
    await writeFile(path.join(root, name), 'fixture', { mode: 0o755 }); files[name] = await sha256(path.join(root, name)); versions[name] = 'fixture-version'
  }
  await writeFile(path.join(root, 'manifest.json'), JSON.stringify({ target: 'darwin-arm64', model, files, versions }))
}
describe.runIf(process.platform === 'darwin' && process.arch === 'arm64')('dependency capability checks', () => {
  it('reports missing dependencies instead of fabricating availability', async () => { expect((await capability()).capability.available).toBe(false) })
  it('rejects mismatched target/model, missing weights, invalid hashes and architecture', async () => {
    await fixture(); expect((await capability()).capability.available).toBe(true)
    control.arch = 'x86_64'; expect((await capability()).capability.reason).toContain('arm64'); control.arch = 'arm64'
    const manifestPath = path.join(root, 'manifest.json'), original = await readFile(manifestPath, 'utf8'), m = JSON.parse(original)
    await writeFile(manifestPath, JSON.stringify({ ...m, target: 'win32-x64' })); expect((await capability()).capability.reason).toContain('不匹配')
    await writeFile(manifestPath, JSON.stringify({ ...m, model: 'wrong-x4' })); expect((await capability()).capability.available).toBe(false)
    await writeFile(manifestPath, original); await writeFile(path.join(root, `models/${model}.param`), 'tampered'); expect((await capability()).capability.reason).toContain('SHA-256')
    await rm(path.join(root, `models/${model}.bin`)); expect((await capability()).capability.available).toBe(false)
    await chmod(path.join(root, 'ffmpeg'), 0o600); expect((await capability()).capability.available).toBe(false)
  })
})
it('explicitly limits unverified platforms', async () => {
  vi.stubGlobal('process', { ...process, platform: 'linux', arch: 'x64' })
  expect((await capability()).capability.reason).toContain('Apple Silicon')
})
