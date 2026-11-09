import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'

interface ProcessOptions {
  timeoutMs?: number
  /** Streaming peers wait for inference; only real pipeline progress renews their watchdog. */
  timeoutMode?: 'total' | 'idle'
}

/** Owned process groups only; no global name-based termination. Drain stderr immediately. */
export class Processes {
  private children = new Set<ChildProcessWithoutNullStreams>()
  private pending = new Set<Promise<void>>()
  constructor(readonly signal: AbortSignal) {}
  start(executable: string, args: string[], options: ProcessOptions = {}): { child: ChildProcessWithoutNullStreams; done: Promise<void>; heartbeat: () => void } {
    this.signal.throwIfAborted()
    const child = spawn(process.execPath, [fileURLToPath(new URL('./supervise.mjs', import.meta.url)), executable, ...args], { shell: false, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe', 'ipc'], env: { ...process.env, MEDIAGRAB_CORE_TOKEN: undefined } }) as ChildProcessWithoutNullStreams
    this.children.add(child)
    let tail = ''
    child.stderr.on('data', (data: Buffer) => { tail = (tail + data.toString()).slice(-6000) })
    // EPIPE is reported by done / write callbacks, not as an uncaught stream error.
    child.stdin.on('error', () => {})
    let stopping = false, timedOut = false
    const timeoutMs = options.timeoutMs ?? 30 * 60_000
    const kill = (): void => {
      if (stopping) return
      stopping = true
      const send = (signal: NodeJS.Signals): void => {
        try { if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal); else child.kill(signal) } catch { /* already exited */ }
      }
      const timer = setTimeout(() => send('SIGKILL'), 1500)
      timer.unref()
      child.once('close', () => clearTimeout(timer))
      send('SIGTERM')
    }
    this.signal.addEventListener('abort', kill, { once: true })
    if (this.signal.aborted) kill()
    const timeout = setTimeout(() => { timedOut = true; kill() }, timeoutMs)
    timeout.unref()
    const done = new Promise<void>((resolve, reject) => {
      child.once('error', reject)
      child.once('close', (code, signal) => {
        stopping = true
        this.children.delete(child)
        this.signal.removeEventListener('abort', kill)
        clearTimeout(timeout)
        const duration = `${Number((timeoutMs / 60_000).toFixed(2))} 分钟`
        const reason = timedOut ? options.timeoutMode === 'idle' ? `连续 ${duration}无处理进展，已停止子进程` : `运行超过 ${duration}，已停止子进程` : ''
        if (code === 0 && !this.signal.aborted && !timedOut) resolve()
        else reject(new Error(this.signal.aborted ? '任务已取消' : reason ? `子进程 ${path.basename(executable)} 超时：${reason}${tail ? `；${tail}` : ''}` : `子进程 ${path.basename(executable)} 失败 (${code ?? signal}): ${tail}`))
      })
    })
    this.pending.add(done)
    void done.catch(() => {}).finally(() => this.pending.delete(done))
    return { child, done, heartbeat: () => { if (options.timeoutMode === 'idle' && !stopping) timeout.refresh() } }
  }
  async run(executable: string, args: string[], maxBytes = 16 * 1024 * 1024, options: ProcessOptions = {}): Promise<string> {
    const { child, done } = this.start(executable, args, options)
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
