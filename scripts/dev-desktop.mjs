import { spawn } from 'node:child_process'
import { cleanupDevPorts } from './cleanup-dev-ports.mjs'

try {
  await cleanupDevPorts()
} catch (error) {
  console.error(`启动桌面开发环境失败：${error.message}`)
  process.exit(1)
}

const child = spawn('pnpm', ['--filter', '@mediagrab/desktop', 'dev'], {
  cwd: process.cwd(),
  env: process.env,
  stdio: 'inherit',
  detached: process.platform !== 'win32',
})

function forward(signal) {
  if (!child.pid) return
  try {
    process.kill(process.platform === 'win32' ? child.pid : -child.pid, signal)
  } catch (error) {
    if (error?.code !== 'ESRCH') throw error
  }
}

process.on('SIGINT', () => forward('SIGINT'))
process.on('SIGTERM', () => forward('SIGTERM'))

child.on('error', (error) => {
  console.error(`Tauri 开发进程启动失败：${error.message}`)
  process.exitCode = 1
})

child.on('exit', (code, signal) => {
  process.exitCode = code ?? (signal ? 1 : 0)
})
