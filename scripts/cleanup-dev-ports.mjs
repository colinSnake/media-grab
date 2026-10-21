import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const DEV_PORTS = [
  {
    port: 9067,
    label: 'Vite web',
    matches({ command }) {
      return command.includes(`${ROOT}/apps/web/`) && command.includes('vite')
    },
  },
  {
    port: 9070,
    label: 'mediaGrab server',
    matches({ command, cwd }) {
      const serverCwd = cwd === ROOT || cwd === resolve(ROOT, 'apps/server')
      return serverCwd && command.includes('tsx') && command.includes('src/index.ts')
    },
  },
]

function commandOutput(command, args) {
  try {
    return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return ''
  }
}

function listeningPids(port) {
  if (process.platform === 'win32') {
    throw new Error('自动清理开发端口目前支持 macOS/Linux；请先手动结束 Windows 上占用端口的进程。')
  }

  if (!existsSync('/usr/sbin/lsof') && !existsSync('/usr/bin/lsof')) {
    throw new Error('找不到 lsof，无法安全判断开发端口对应的进程。')
  }

  return commandOutput('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'])
    .split('\n')
    .map((pid) => Number(pid.trim()))
    .filter((pid) => Number.isInteger(pid) && pid > 0)
}

function processCommand(pid) {
  return commandOutput('ps', ['-ww', '-p', String(pid), '-o', 'command='])
}

function processCwd(pid) {
  const output = commandOutput('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'])
  return output
    .split('\n')
    .find((line) => line.startsWith('n'))
    ?.slice(1)
    .trim()
}

function terminate(pid, signal) {
  try {
    process.kill(pid, signal)
    return true
  } catch (error) {
    if (error?.code === 'ESRCH') return false
    throw error
  }
}

function wait(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds))
}

export async function cleanupDevPorts() {
  const owned = []

  for (const entry of DEV_PORTS) {
    for (const pid of listeningPids(entry.port)) {
      const command = processCommand(pid)
      const cwd = processCwd(pid)
      if (!entry.matches({ command, cwd })) {
        throw new Error(
          `端口 ${entry.port} 已被其他进程占用（PID ${pid}: ${command || '命令行不可见'}，cwd=${cwd || '未知'}）。未自动结束该进程。`,
        )
      }
      owned.push({ ...entry, pid, command, cwd })
    }
  }

  if (owned.length === 0) return

  for (const entry of owned) {
    console.log(`结束旧的 ${entry.label} 进程（PID ${entry.pid}，端口 ${entry.port}）`)
    terminate(entry.pid, 'SIGTERM')
  }

  await wait(300)

  for (const entry of owned) {
    if (listeningPids(entry.port).includes(entry.pid)) {
      console.warn(`PID ${entry.pid} 未响应 SIGTERM，发送 SIGKILL`)
      terminate(entry.pid, 'SIGKILL')
    }
  }
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  cleanupDevPorts().catch((error) => {
    console.error(`开发端口清理失败：${error.message}`)
    process.exitCode = 1
  })
}
