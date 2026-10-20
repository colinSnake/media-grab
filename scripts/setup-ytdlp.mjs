import { existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import process from 'node:process'

const root = process.cwd()
const venv = path.join(root, '.venv')
const python = process.platform === 'win32'
  ? path.join(venv, 'Scripts', 'python.exe')
  : path.join(venv, 'bin', 'python')

function createVenv() {
  for (const command of process.platform === 'win32' ? ['py', 'python'] : ['python3', 'python']) {
    try {
      execFileSync(command, ['-m', 'venv', venv], { cwd: root, stdio: 'inherit' })
      return
    } catch {
      // Try the next Python launcher when the preferred one is unavailable.
    }
  }
  throw new Error('未找到可用的 Python 解释器。macOS/Linux 请安装 python3，Windows 请安装 Python 或 Python Launcher。')
}

if (!existsSync(python)) {
  console.log('正在创建项目 Python 虚拟环境 .venv ...')
  createVenv()
}

console.log('正在安装或更新项目内 yt-dlp ...')
execFileSync(python, ['-m', 'pip', 'install', '--upgrade', 'yt-dlp'], { cwd: root, stdio: 'inherit' })
console.log('yt-dlp 已安装到项目 .venv，mediaGrab 会自动发现它。')
