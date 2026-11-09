import { PassThrough } from 'node:stream'
import { beforeEach, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => ({ bytes: Buffer.from('89504e470d0a1a0a', 'hex'), error: false, kill: vi.fn(), start: vi.fn() }))
vi.mock('./process.js', () => ({ Processes: class {
  start(...args: unknown[]) {
    fixture.start(...args)
    const stdout = new PassThrough()
    const done = Promise.resolve().then(() => {
      stdout.emit('data', fixture.bytes)
      if (fixture.error) throw new Error('fixture ffmpeg failed')
    })
    return { child: { stdout, stdin: { end() {} }, kill: fixture.kill }, done }
  }
} }))
import { firstFrame } from './thumbnail.js'
beforeEach(() => { fixture.bytes = Buffer.from('89504e470d0a1a0a', 'hex'); fixture.error = false; fixture.start.mockClear(); fixture.kill.mockClear() })
it('reads exactly the first video frame with bounded PNG output and local-only decoding', async () => {
  expect(await firstFrame('fixture-ffmpeg', '/fixture/中文.mp4', new AbortController().signal)).toEqual(fixture.bytes)
  const [executable, args, options] = fixture.start.mock.calls[0]!
  expect(executable).toBe('fixture-ffmpeg')
  expect(args).toEqual(expect.arrayContaining(['-frames:v', '1', '-f', 'image2pipe', '-c:v', 'png', 'scale=320:180:force_original_aspect_ratio=decrease,format=rgb24', '-enable_drefs', '0', '-protocol_whitelist', 'file,pipe']))
  expect(args).not.toContain('-ss')
  expect(options).toEqual({ timeoutMs: 15_000 })
})
it('rejects empty or non-image output', async () => {
  for (const bytes of [Buffer.alloc(0), Buffer.from('not png')]) {
    fixture.bytes = bytes
    await expect(firstFrame('fixture', '/fixture/input.mp4', new AbortController().signal)).rejects.toThrow('预览')
  }
})
it('terminates oversized output and never returns a truncated image', async () => {
  fixture.bytes = Buffer.alloc(512 * 1024 + 1)
  await expect(firstFrame('fixture', '/fixture/input.mp4', new AbortController().signal)).rejects.toThrow('大小限制')
  expect(fixture.kill).toHaveBeenCalledWith('SIGTERM')
})
it('preserves decode failure diagnostics', async () => {
  fixture.error = true
  await expect(firstFrame('fixture', '/fixture/input.mp4', new AbortController().signal)).rejects.toThrow('ffmpeg failed')
})

it('uses a restricted still-image demuxer for image previews', async () => {
  await firstFrame('fixture-ffmpeg', '/fixture/input.png', new AbortController().signal, 'image')
  const [, args] = fixture.start.mock.calls.at(-1)!
  expect(args).toEqual(expect.arrayContaining(['-protocol_whitelist', 'file', '-f', 'image2', '-pattern_type', 'none']))
  expect(args).not.toContain('mov')
})
