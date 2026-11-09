import { describe, expect, it, vi } from 'vitest'
import type { RepairStrokes } from '@mediagrab/shared'
import { exclusiveInference, rasterizeMask } from './inpainting.js'

describe('repair mask rasterization', () => {
  it('maps normalized single-point strokes to a bounded circular mask', () => {
    const mask = rasterizeMask(32, 24, [{ radius: 0.1, points: [{ x: 0.5, y: 0.5 }] }])
    expect(mask[12 * 32 + 16]).toBe(255)
    expect(mask[0]).toBe(0)
    expect(mask).toContain(255)
  })

  it('rejects pathological long back-and-forth strokes before monopolizing the event loop', () => {
    const points = Array.from({ length: 256 }, (_, i) => ({ x: i % 2 ? 1 : 0, y: i % 2 ? 1 : 0 }))
    const stroke: RepairStrokes = [{ radius: 0.001, points }]
    expect(() => rasterizeMask(4096, 4096, stroke)).toThrow('选区轨迹过于复杂')
  })

  it('cancels a queued inference without releasing the active inference slot', async () => {
    let finishFirst!: () => void
    const first = exclusiveInference(new AbortController().signal, () => new Promise<void>((resolve) => { finishFirst = resolve }))
    const queuedAbort = new AbortController()
    const queuedRun = vi.fn(async () => {})
    const queued = exclusiveInference(queuedAbort.signal, queuedRun)
    const nextRun = vi.fn(async () => {})
    const next = exclusiveInference(new AbortController().signal, nextRun)

    queuedAbort.abort()
    await expect(queued).rejects.toThrow('任务已取消')
    expect(queuedRun).not.toHaveBeenCalled()
    expect(nextRun).not.toHaveBeenCalled()
    finishFirst()
    await first
    await next
    expect(nextRun).toHaveBeenCalledOnce()
  })
})
