/** Read-only preflight helpers. Importing this module never starts the app. */
import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { access, realpath, stat } from 'node:fs/promises'
import { createConnection } from 'node:net'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { systemDylibsOnly } from './build-upscale-ffmpeg.mjs'

export const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export function developmentToolDirectory(env = process.env) {
  const value = env.MEDIAGRAB_UPSCALE_DIR?.trim() || path.join(repositoryRoot, '.release-tools/upscale-offline-test')
  if (!path.isAbsolute(value)) throw new Error('MEDIAGRAB_UPSCALE_DIR 必须是显式绝对路径')
  return value
}
/** Development entry only: never stage unreviewed tools into release resources. */
export async function desktopDevelopmentEnvironment(env = process.env, { root = repositoryRoot, platform = process.platform, arch = process.arch } = {}) {
  const result = { ...env }
  if (env.MEDIAGRAB_UPSCALE_DIR?.trim()) {
    result.MEDIAGRAB_UPSCALE_DIR = developmentToolDirectory(env)
    return result
  }
  if (platform !== 'darwin' || arch !== 'arm64') return result
  const hasManifest = async (directory) => {
    try { return (await stat(path.join(directory, 'manifest.json'))).isFile() }
    catch (error) { if (['ENOENT', 'ENOTDIR'].includes(error.code)) return false; throw error }
  }
  const resources = path.join(root, 'apps/desktop/src-tauri/resources/media-tools')
  // Prefer deliberately staged resources; let the core validate their manifest.
  for (const directory of [path.join(resources, `${platform}-${arch}`, 'upscale'), path.join(resources, 'upscale')]) {
    if (await hasManifest(directory)) return result
  }
  const directory = path.join(root, '.release-tools/upscale-offline-test')
  if (await hasManifest(directory)) result.MEDIAGRAB_UPSCALE_DIR = directory
  // Missing/invalid dependencies remain unavailable; the core still verifies hashes,
  // architectures and supported codecs before it reports availability.
  return result
}
export async function verifyDevelopmentTools(directory, node = process.execPath) {
  const root = await realpath(directory)
  const module = path.join(repositoryRoot, 'apps/server/dist/upscale/tools.js')
  await access(module); await access(path.join(repositoryRoot, 'apps/server/dist/upscale/supervise.mjs'))
  const code = `const { capability } = await import(${JSON.stringify(pathToFileURL(module).href)}); const result = await capability(); console.log(JSON.stringify(result.capability)); if (!result.capability.available) process.exitCode = 1;`
  const env = { ...process.env, MEDIAGRAB_UPSCALE_DIR: root, MEDIAGRAB_CORE_TOKEN: undefined }
  let output
  try { output = execFileSync(node, ['--input-type=module', '-e', code], { cwd: repositoryRoot, env, encoding: 'utf8', timeout: 30000, maxBuffer: 4 * 1024 ** 2 }) }
  catch (error) { throw new Error(`超分依赖检查失败；先运行 pnpm build 并显式准备本机工具。\n${error.stdout?.toString().trim() || error.message}`, { cause: error }) }
  const capability = JSON.parse(output)
  if (!capability.available) throw new Error(capability.reason)
  for (const name of ['ffmpeg', 'ffprobe', 'realesrgan-ncnn-vulkan']) {
    systemDylibsOnly(execFileSync('/usr/bin/otool', ['-L', path.join(root, name)], { encoding: 'utf8' }))
  }
  return capability
}
async function listening(port, host) {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ port, host })
    socket.once('connect', () => { socket.destroy(); resolve(true) })
    socket.once('error', (error) => {
      socket.destroy()
      if (['ECONNREFUSED', 'ENETUNREACH', 'EHOSTUNREACH', 'EADDRNOTAVAIL'].includes(error.code)) resolve(false)
      else reject(error)
    })
    socket.setTimeout(750, () => { socket.destroy(); reject(new Error(`端口 ${host}:${port} 检查超时；不会终止现有进程`)) })
  })
}
export async function assertPortsFree(ports = [9067, 9070]) {
  for (const port of ports) for (const host of ['127.0.0.1', '::1']) {
    if (await listening(port, host)) throw new Error(`端口 ${host}:${port} 已被占用。请自行确认并退出相关程序后重试；测试入口不会清端口、退出或重启现有应用。`)
  }
}
export function isolatedDesktopEnvironment(directory, tools, env = process.env) {
  if (!path.isAbsolute(directory) || !path.isAbsolute(tools)) throw new Error('测试数据和依赖必须使用绝对路径')
  return {
    ...env, DATA_DIR: directory, DB_PATH: path.join(directory, 'mediaGrab.db'),
    MEDIAGRAB_DESKTOP_TEST_DATA_DIR: directory,
    MEDIAGRAB_UPSCALE_DIR: tools, MEDIAGRAB_DESKTOP_CORE: '1', MEDIAGRAB_CORE_TOKEN: randomBytes(32).toString('hex'),
    HOST: '127.0.0.1', PORT: '9070', DEV_API_TARGET: 'http://127.0.0.1:9070',
  }
}
