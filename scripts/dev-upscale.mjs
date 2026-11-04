/** Only --launch starts a desktop app, and only when the user runs that command. */
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, realpath } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertPortsFree, developmentToolDirectory, isolatedDesktopEnvironment, repositoryRoot, verifyDevelopmentTools } from './upscale-dev-support.mjs'

export async function main(args = process.argv.slice(2)) {
  if (args.length !== 1 || !['--check', '--launch'].includes(args[0])) throw new Error('使用 pnpm verify:upscale-dev（仅检查）或由用户手动执行 pnpm dev:desktop:upscale（启动测试桌面）')
  if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('首版桌面超分测试仅支持 macOS Apple Silicon')
  await assertPortsFree()
  const tools = developmentToolDirectory()
  const capability = await verifyDevelopmentTools(tools)
  console.log(`超分依赖已就绪：${tools}\n模型：${capability.model}\n9067/9070 当前未被占用；检查没有启动应用或创建测试数据库。`)
  if (args[0] === '--check') return
  // No calls to cleanup-dev-ports, global kill, installation or runtime staging.
  const artifacts = path.join(repositoryRoot, 'artifacts'); await mkdir(artifacts, { recursive: true })
  const data = await realpath(await mkdtemp(path.join(artifacts, 'upscale-desktop-test-')))
  console.log(`测试数据库/设置目录（保留用于验收）：${data}\n请在“媒体工具 → 视频超分”操作；本入口不会覆盖 data/ 或已安装应用的数据。`)
  const child = spawn('pnpm', ['--filter', '@mediagrab/desktop', 'dev'], {
    cwd: repositoryRoot, env: isolatedDesktopEnvironment(data, tools), stdio: 'inherit', detached: true,
  })
  const forward = (signal) => { if (child.pid) try { process.kill(-child.pid, signal) } catch (error) { if (error.code !== 'ESRCH') throw error } }
  const interrupt = () => forward('SIGINT'), terminate = () => forward('SIGTERM')
  process.on('SIGINT', interrupt); process.on('SIGTERM', terminate)
  child.once('error', (error) => { console.error(error.message); process.exitCode = 1 })
  child.once('exit', (code, signal) => {
    process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', terminate)
    process.exitCode = code ?? (signal ? 1 : 0)
  })
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main().catch((error) => { console.error(error.message); process.exitCode = 1 })
}
