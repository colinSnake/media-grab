import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'

/** Owned process groups only; no global name-based termination. Drain stderr immediately. */
export class Processes {
  private children = new Set<ChildProcessWithoutNullStreams>()
  private pending = new Set<Promise<void>>()
  constructor(readonly signal: AbortSignal) {}
  start(executable: string, args: string[]): { child: ChildProcessWithoutNullStreams; done: Promise<void> } {
    this.signal.throwIfAborted()
    const child = spawn(process.execPath, [fileURLToPath(new URL('./supervise.mjs', import.meta.url)), executable, ...args], { shell: false, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe', 'ipc'], env: { ...process.env, MEDIAGRAB_CORE_TOKEN: undefined } }) as ChildProcessWithoutNullStreams
    this.children.add(child)
    let tail = ''
    child.stderr.on('data', (data: Buffer) => { tail = (tail + data.toString()).slice(-6000) })
    // EPIPE is reported by done / write callbacks, not as an uncaught stream error.
    child.stdin.on('error', () => {})
    const kill = (): void => {
      const send = (signal: NodeJS.Signals): void => {
        try { if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal); else child.kill(signal) } catch { /* already exited */ }
      }
      send('SIGTERM')
      const timer = setTimeout(() => send('SIGKILL'), 1500)
      timer.unref()
      child.once('close', () => clearTimeout(timer))
    }
    this.signal.addEventListener('abort', kill, { once: true })
    if (this.signal.aborted) kill()
    const timeout = setTimeout(kill, 30 * 60_000)
    timeout.unref()
    const done = new Promise<void>((resolve, reject) => {
      child.once('error', reject)
      child.once('close', (code, signal) => {
        this.children.delete(child)
        this.signal.removeEventListener('abort', kill)
        clearTimeout(timeout)
        if (code === 0 && !this.signal.aborted) resolve()
        else reject(new Error(this.signal.aborted ? '任务已取消' : `子进程 ${path.basename(executable)} 失败 (${code ?? signal}): ${tail}`))
      })
    })
    this.pending.add(done)
    void done.catch(() => {}).finally(() => this.pending.delete(done))
    return { child, done }
  }
  async run(executable: string, args: string[], maxBytes = 16 * 1024 * 1024): Promise<string> {
    const { child, done } = this.start(executable, args)
    child.stdin.end()
    const chunks: Buffer[] = []
    let bytes = 0
    let overflow = false
    child.stdout.on('data', (data: Buffer) => {
      bytes += data.length
      if (bytes <= maxBytes) chunks.push(data)
      // Keep the watchdog alive long enough to reap its detached tool group.
      // SIGKILL here would strand the tool that produced the oversized output.
      else if (!overflow) { overflow = true; child.kill('SIGTERM') }
    })
    try { await done } catch (error) {
      const diagnostic = Buffer.concat(chunks).subarray(-2048).toString().replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, ' ').trim()
      if (overflow) throw new Error('工具输出超出安全上限', { cause: error })
      if (diagnostic) throw new Error(`${error instanceof Error ? error.message : String(error)}\n${diagnostic}`, { cause: error })
      throw error
    }
    if (overflow) throw new Error('工具输出超出安全上限')
    return Buffer.concat(chunks).toString()
  }
  async settle(): Promise<void> { await Promise.allSettled([...this.pending]) }
}
