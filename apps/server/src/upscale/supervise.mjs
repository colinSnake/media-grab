/**
 * Per-tool watchdog, executed with the already bundled Node runtime (no new runtime).
 * An IPC disconnect detects even a SIGKILL/crash of the core. Only the tool group
 * created here is terminated; no process-name scans or shell commands are used.
 */
import { spawn } from 'node:child_process'
const [executable, ...args] = process.argv.slice(2)
if (!executable || !process.send) throw new Error('Tool supervisor requires an executable and parent IPC')
const child = spawn(executable, args, { shell: false, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] })
process.stdin.pipe(child.stdin)
child.stdout.pipe(process.stdout)
child.stderr.pipe(process.stderr)
child.stdin.on('error', () => {})
let stopping = false
let timer
function terminate(signal) {
  try { if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal); else child.kill(signal) } catch { /* already reaped */ }
}
function stop() {
  if (stopping) return
  stopping = true
  terminate('SIGTERM')
  timer = setTimeout(() => terminate('SIGKILL'), 800)
  timer.unref()
}
process.stdout.on('error', stop)
process.stderr.on('error', stop)
process.stdin.on('error', stop)
process.on('disconnect', stop)
process.on('SIGTERM', stop)
process.on('SIGINT', stop)
child.once('error', (error) => { process.stderr.write(error.message); process.exitCode = 127 })
child.once('close', (code) => {
  if (timer) clearTimeout(timer)
  process.stdin.destroy()
  process.exitCode = code === 0 && !stopping ? 0 : code || 1
  if (process.connected) process.disconnect()
})

if (!process.connected) stop()
