import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('node:child_process', () => ({ spawn: vi.fn() }))
import { spawn } from 'node:child_process'
import { Processes } from './process.js'

let child: ChildProcessWithoutNullStreams, abort: AbortController, processes: Processes
beforeEach(() => {
  vi.useFakeTimers()
  // No executable, actual task, user database, or process group is touched.
  child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() }) as unknown as ChildProcessWithoutNullStreams
  vi.mocked(spawn).mockReturnValue(child)
  abort = new AbortController(); processes = new Processes(abort.signal)
})
afterEach(async () => {
  abort.abort(); child.emit('close', 255, null); await processes.settle()
  vi.useRealTimers(); vi.clearAllMocks()
})
const minute = 60_000

describe('upscale subprocess watchdog policy (simulated clock)', () => {
  it('allows streaming jobs longer than 30 minutes while frame/batch progress continues', async () => {
    const stream = processes.start('/fixture/ffmpeg', [], { timeoutMode: 'idle' })
    // 100 minutes of progress, without periodic heartbeats from a timer.
    for (let batch = 0; batch < 4; batch++) { await vi.advanceTimersByTimeAsync(25 * minute); stream.heartbeat() }
    expect(child.kill).not.toHaveBeenCalled()
    child.emit('close', 0, null); await expect(stream.done).resolves.toBeUndefined()
    stream.heartbeat(); await vi.advanceTimersByTimeAsync(31 * minute)
    expect(child.kill).not.toHaveBeenCalled() // completion must not rearm the timer
  })
  it('still stops a stalled streaming child and reports timeout instead of an empty 255 error', async () => {
    const stream = processes.start('/fixture/ffmpeg', [], { timeoutMode: 'idle' })
    await vi.advanceTimersByTimeAsync(25 * minute); stream.heartbeat()
    await vi.advanceTimersByTimeAsync(29 * minute); expect(child.kill).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(minute); expect(child.kill).toHaveBeenCalledWith('SIGTERM')
    // A late progress event cannot resurrect a timed-out task.
    stream.heartbeat(); child.emit('close', 255, null)
    await expect(stream.done).rejects.toThrow('ffmpeg 超时：连续 30 分钟无处理进展')
  })
  it('keeps a hard limit for probes and individual inference batches', async () => {
    const tool = processes.start('/fixture/engine', [])
    await vi.advanceTimersByTimeAsync(25 * minute); tool.heartbeat()
    await vi.advanceTimersByTimeAsync(5 * minute); expect(child.kill).toHaveBeenCalledWith('SIGTERM')
    child.emit('close', 255, null)
    await expect(tool.done).rejects.toThrow('运行超过 30 分钟')
  })
  it('cancels long-lived children and escalates only the owned child when it does not exit', async () => {
    const tool = processes.start('/fixture/ffmpeg', [], { timeoutMode: 'idle' })
    abort.abort(); expect(child.kill).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1500); expect(child.kill).toHaveBeenLastCalledWith('SIGKILL')
    child.emit('close', 255, null); await expect(tool.done).rejects.toThrow('任务已取消')
    await vi.advanceTimersByTimeAsync(31 * minute); expect(child.kill).toHaveBeenCalledTimes(2)
  })
  it('keeps tool stderr in timeout diagnostics', async () => {
    const tool = processes.start('/fixture/ffprobe', [])
    child.stderr.emit('data', Buffer.from('fixture diagnostic'))
    await vi.advanceTimersByTimeAsync(30 * minute); child.emit('close', 255, null)
    await expect(tool.done).rejects.toThrow('fixture diagnostic')
  })
})
