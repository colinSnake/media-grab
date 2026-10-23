import { describe, expect, it } from 'vitest'
import { ExtractorGate } from './extractor-gate.js'

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  return { promise: new Promise<void>((done) => { resolve = done }), resolve }
}

describe('ExtractorGate', () => {
  it('runs only one extractor at a time and preserves queue order', async () => {
    const gate = new ExtractorGate(0)
    const first = deferred()
    const starts: number[] = []
    const a = gate.run(async () => { starts.push(1); await first.promise; return 1 })
    const b = gate.run(async () => { starts.push(2); return 2 })
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(starts).toEqual([1])
    first.resolve()
    expect(await Promise.all([a, b])).toEqual([1, 2])
    expect(starts).toEqual([1, 2])
  })

  it('aborts a waiter immediately without letting the next request overtake the active job', async () => {
    const gate = new ExtractorGate(0)
    const first = deferred()
    const starts: number[] = []
    const a = gate.run(async () => { starts.push(1); await first.promise })
    const controller = new AbortController()
    const b = gate.run(async () => { starts.push(2) }, controller.signal)
    const c = gate.run(async () => { starts.push(3) })
    controller.abort()
    await expect(b).rejects.toMatchObject({ code: 'TASK_CANCELLED' })
    expect(starts).toEqual([1])
    first.resolve()
    await Promise.all([a, c])
    expect(starts).toEqual([1, 3])
  })

  it('bounds the pending queue and exposes a retryable risk error', async () => {
    const gate = new ExtractorGate(0, 1)
    const first = deferred()
    const a = gate.run(async () => first.promise)
    await expect(gate.run(async () => undefined)).rejects.toMatchObject({
      code: 'EXTRACTOR_BUSY', kind: 'risk', httpStatus: 429, retryable: true,
    })
    first.resolve()
    await a
    await expect(gate.run(async () => 3)).resolves.toBe(3)
  })

  it('respects a minimum interval between starting processes', async () => {
    const gate = new ExtractorGate(40)
    const starts: number[] = []
    await gate.run(async () => { starts.push(Date.now()) })
    await gate.run(async () => { starts.push(Date.now()) })
    expect(starts[1]! - starts[0]!).toBeGreaterThanOrEqual(38)
  })
})
