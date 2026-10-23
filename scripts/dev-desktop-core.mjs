import { spawn } from 'node:child_process'

const children = new Set()
let shuttingDown = false

function start(name, args, { restart = false } = {}) {
  const child = spawn('pnpm', args, {
    cwd: process.cwd(),
    env: process.env,
    stdio: 'inherit',
    detached: process.platform !== 'win32',
  })
  children.add(child)

  child.on('exit', (code, signal) => {
    children.delete(child)
    if (shuttingDown) return

    if (restart) {
      console.error(`${name} 已退出（code=${code ?? 'null'}, signal=${signal ?? 'null'}），1.5 秒后自动重试`)
      setTimeout(() => {
        if (!shuttingDown) start(name, args, { restart: true })
      }, 1_500)
      return
    }

    console.error(`${name} 已退出（code=${code ?? 'null'}, signal=${signal ?? 'null'}），正在停止其他开发进程`)
    void shutdown(code ?? 1)
  })

  child.on('error', (error) => {
    console.error(`${name} 启动失败：${error.message}`)
    void shutdown(1)
  })
}

function signalProcessTree(child, signal) {
  if (!child.pid) return

  try {
    process.kill(process.platform === 'win32' ? child.pid : -child.pid, signal)
  } catch (error) {
    if (error?.code !== 'ESRCH') throw error
  }
}

async function shutdown(code) {
  if (shuttingDown) return
  shuttingDown = true

  for (const child of children) signalProcessTree(child, 'SIGTERM')
  await new Promise((resolve) => setTimeout(resolve, 500))
  for (const child of children) signalProcessTree(child, 'SIGKILL')
  process.exit(code)
}

process.on('SIGINT', () => void shutdown(130))
process.on('SIGTERM', () => void shutdown(143))

start('server', ['--filter', '@mediagrab/server', 'dev'], { restart: true })
start('web', ['--filter', '@mediagrab/web', 'dev'])
