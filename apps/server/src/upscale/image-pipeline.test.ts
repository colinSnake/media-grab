import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
vi.mock('./probe.js', () => ({ inspectImage: async () => ({}), supportedImage: () => ({ width: 32, height: 24, frames: 1, duration: 1, fps: '1/1', audio: false }) }))
vi.mock('./pipeline.js', () => ({ checkSpace: async () => {} }))
vi.mock('./inpainting.js', () => ({ repairPngFile: vi.fn(async (input: string) => input) }))
import { imagePipeline } from './image-pipeline.js'
import { repairPngFile } from './inpainting.js'
import type { Processes } from './process.js'
const tools = { ffmpeg: 'fixture-ffmpeg', ffprobe: 'fixture-ffprobe', engine: 'fixture-engine', models: '/fixture/models' }
let root: string, input: string, work: string
function header(width: number, height: number): Buffer {
  const bytes = Buffer.alloc(24)
  Buffer.from('89504e470d0a1a0a', 'hex').copy(bytes); bytes.write('IHDR', 12); bytes.writeUInt32BE(width, 16); bytes.writeUInt32BE(height, 20)
  return bytes
}
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'image-pipeline-unit-')); work = path.join(root, 'work')
  const { mkdir } = await import('node:fs/promises'); await mkdir(work)
  input = path.join(root, 'image.jpg'); await writeFile(input, 'source fixture, not actual image')
  vi.mocked(repairPngFile).mockClear()
})
afterEach(async () => { await rm(root, { recursive: true, force: true }) })
function processes(mode = 'success'): Processes {
  return { signal: new AbortController().signal, run: vi.fn(async (file: string, args: string[]) => {
    if (file === tools.engine) {
      if (mode === 'engine-fail') throw new Error('native engine failed')
      await writeFile(path.join(work, 'out/input.png'), mode === 'corrupt-output' ? Buffer.from('invalid') : header(mode === 'wrong-size' ? 63 : 64, 48))
    } else if (args.at(-1) !== '-') await writeFile(path.join(work, 'in/input.png'), header(mode === 'wrong-decode' ? 31 : 32, 24))
    else if (mode === 'decode-fail') throw new Error('full output decode failed')
    return ''
  }) } as unknown as Processes
}
it('uses bounded single-image decoding, hashes the candidate, and never rewrites the source', async () => {
  const process = processes(), stages: string[] = []
  const result = await imagePipeline(input, work, tools, process, (stage) => stages.push(stage))
  expect(result).toMatchObject({ bytes: 24, sha256: expect.stringMatching(/^[a-f0-9]{64}$/) })
  expect(stages).toEqual(['probing', 'decoding', 'upscaling', 'validating', 'done'])
  expect(await readFile(input, 'utf8')).toBe('source fixture, not actual image')
  expect(vi.mocked(process.run).mock.calls[0]![1]).toEqual(expect.arrayContaining(['-f', 'image2', '-pattern_type', 'none', '-frames:v', '1']))
})
it('runs repair before passing the repaired directory to the real engine interface', async () => {
  const process = processes(), strokes = [{ radius: .04, points: [{ x: .5, y: .5 }] }]
  await imagePipeline(input, work, tools, process, () => {}, strokes)
  expect(repairPngFile).toHaveBeenCalledOnce()
  const engine = vi.mocked(process.run).mock.calls.find(([file]) => file === tools.engine)!
  expect(engine[1]).toContain(path.join(work, 'repaired'))
})
it.each(['wrong-size', 'wrong-decode', 'corrupt-output', 'engine-fail', 'decode-fail'])('refuses %s instead of returning an apparently successful result', async (mode) => {
  await expect(imagePipeline(input, work, tools, processes(mode), () => {})).rejects.toThrow()
  expect(await readFile(input, 'utf8')).toBe('source fixture, not actual image')
})
