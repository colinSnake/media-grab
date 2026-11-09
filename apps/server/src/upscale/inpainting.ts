import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { repairModelPath } from './repair-capability.js'
import type { RepairStrokes, UpscaleMedia } from '@mediagrab/shared'
import { Processes } from './process.js'

const side = 512
const maxMaskRasterWork = 16_000_000
let inferenceTail: Promise<void> = Promise.resolve()

export async function exclusiveInference<T>(signal: AbortSignal, run: () => Promise<T>): Promise<T> {
  let release!: () => void
  const previous = inferenceTail
  const turn = new Promise<void>((resolve) => { release = resolve })
  inferenceTail = previous.then(() => turn)
  let removeAbortListener = () => {}
  try {
    signal.throwIfAborted()
    await Promise.race([previous, new Promise<never>((_, reject) => {
      const abort = () => reject(new Error('任务已取消'))
      signal.addEventListener('abort', abort, { once: true })
      removeAbortListener = () => signal.removeEventListener('abort', abort)
      if (signal.aborted) abort()
    })])
    removeAbortListener()
    signal.throwIfAborted()
    return await run()
  } finally { removeAbortListener(); release() }
}

export function rasterizeMask(width: number, height: number, strokes: RepairStrokes): Uint8Array {
  const mask = new Uint8Array(width * height)
  let rasterWork = 0
  const paint = (cx: number, cy: number, radius: number) => {
    const left = Math.max(0, Math.floor(cx - radius)), right = Math.min(width - 1, Math.ceil(cx + radius))
    const top = Math.max(0, Math.floor(cy - radius)), bottom = Math.min(height - 1, Math.ceil(cy + radius))
    rasterWork += (right - left + 1) * (bottom - top + 1)
    if (rasterWork > maxMaskRasterWork) throw new Error('选区轨迹过于复杂，请减少笔画或缩小笔刷后重试')
    for (let y = top; y <= bottom; y++) for (let x = left; x <= right; x++) if ((x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2) mask[y * width + x] = 255
  }
  for (const stroke of strokes) {
    const radius = Math.max(2, stroke.radius * Math.min(width, height))
    const points = stroke.points.map(({ x, y }) => ({ x: Math.round(x * (width - 1)), y: Math.round(y * (height - 1)) }))
    if (points.length === 1) { paint(points[0]!.x, points[0]!.y, radius); continue }
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1]!, b = points[i]!, steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / Math.max(1, radius / 2)))
      for (let step = 0; step <= steps; step++) paint(a.x + (b.x - a.x) * step / steps, a.y + (b.y - a.y) * step / steps, radius)
    }
  }
  return mask
}

function fitToModel(width: number, height: number) {
  const scale = Math.min(side / width, side / height)
  const scaledWidth = Math.max(1, Math.round(width * scale)), scaledHeight = Math.max(1, Math.round(height * scale))
  return { width: scaledWidth, height: scaledHeight, left: Math.floor((side - scaledWidth) / 2), top: Math.floor((side - scaledHeight) / 2), scale }
}

async function ffmpegFile(ffmpeg: string, args: string[], signal: AbortSignal): Promise<void> {
  const processes = new Processes(signal)
  await processes.run(ffmpeg, ['-v', 'error', '-xerror', '-nostdin', ...args])
}

async function inference(pixels: Buffer, width: number, height: number, strokes: RepairStrokes, ffmpeg: string, work: string, signal: AbortSignal): Promise<Buffer> {
  const expected = width * height * 3
  if (pixels.length !== width * height * 4 || expected > 32 * 1024 ** 2) throw new Error('修补图片数据尺寸不合法')
  const originalMask = rasterizeMask(width, height, strokes)
  if (!originalMask.some((value) => value > 0)) throw new Error('请先涂选需要修补的区域')
  const fit = fitToModel(width, height)
  const rawInput = path.join(work, 'input.rgb')
  const fittedInput = path.join(work, 'model-input.rgb')
  const sourceRgb = Buffer.alloc(expected)
  for (let i = 0; i < width * height; i++) { sourceRgb[i * 3] = pixels[i * 4]!; sourceRgb[i * 3 + 1] = pixels[i * 4 + 1]!; sourceRgb[i * 3 + 2] = pixels[i * 4 + 2]! }
  await writeFile(rawInput, sourceRgb)
  await ffmpegFile(ffmpeg, ['-f', 'rawvideo', '-pixel_format', 'rgb24', '-video_size', `${width}x${height}`, '-i', rawInput, '-vf', `scale=${fit.width}:${fit.height}:flags=area,pad=512:512:${fit.left}:${fit.top}:color=black`, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', fittedInput], signal)
  const fittedPixels = await readFile(fittedInput)
  if (fittedPixels.length !== side * side * 3) throw new Error('模型输入尺寸校验失败')
  const mask = new Float32Array(side * side), image = new Float32Array(3 * side * side)
  const fittedMask = rasterizeMask(fit.width, fit.height, strokes)
  for (let y = 0; y < fit.height; y++) for (let x = 0; x < fit.width; x++) mask[(fit.top + y) * side + fit.left + x] = fittedMask[y * fit.width + x]! / 255
  for (let i = 0; i < side * side; i++) {
    const p = i * 3
    image[i] = fittedPixels[p]! / 255; image[side * side + i] = fittedPixels[p + 1]! / 255; image[2 * side * side + i] = fittedPixels[p + 2]! / 255
  }
  signal.throwIfAborted()
  return exclusiveInference(signal, async () => {
    const modelInput = path.join(work, 'model-input.f32'), maskInput = path.join(work, 'model-mask.f32'), modelOutput = path.join(work, 'model-output.f32')
    await writeFile(modelInput, Buffer.from(image.buffer, image.byteOffset, image.byteLength))
    await writeFile(maskInput, Buffer.from(mask.buffer, mask.byteOffset, mask.byteLength))
    const runner = fileURLToPath(new URL('./inpainting-runner.mjs', import.meta.url))
    const processes = new Processes(signal)
    await processes.run(process.execPath, [runner, repairModelPath(), modelInput, maskInput, modelOutput])
    const outputBytes = await readFile(modelOutput)
    if (outputBytes.length !== 3 * side * side * Float32Array.BYTES_PER_ELEMENT) throw new Error('模型输出尺寸无效')
    const values = new Float32Array(outputBytes.buffer, outputBytes.byteOffset, outputBytes.byteLength / Float32Array.BYTES_PER_ELEMENT)
    if (values.some((value) => !Number.isFinite(value))) throw new Error('模型输出无效')
    const modelPixels = Buffer.alloc(side * side * 3)
    for (let i = 0; i < side * side; i++) for (let c = 0; c < 3; c++) modelPixels[i * 3 + c] = Math.max(0, Math.min(255, Math.round(values[c * side * side + i]!)))
    const modelRaw = path.join(work, 'model-output.rgb'), resized = path.join(work, 'repaired.rgb')
    await writeFile(modelRaw, modelPixels)
    await ffmpegFile(ffmpeg, ['-f', 'rawvideo', '-pixel_format', 'rgb24', '-video_size', '512x512', '-i', modelRaw, '-vf', `crop=${fit.width}:${fit.height}:${fit.left}:${fit.top},scale=${width}:${height}:flags=lanczos`, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', resized], signal)
    const repaired = await readFile(resized)
    if (repaired.length !== expected) throw new Error('修补结果尺寸与原图不匹配')
    for (let i = 0; i < width * height; i++) {
      const alpha = originalMask[i]! / 255
      if (!alpha) continue
      const source = i * 4, result = i * 3
      for (let c = 0; c < 3; c++) pixels[source + c] = Math.round(pixels[source + c]! * (1 - alpha) + repaired[result + c]! * alpha)
    }
    return pixels
  })
}

async function decodePixels(ffmpeg: string, input: string, work: string, signal: AbortSignal): Promise<Buffer> {
  const raw = path.join(work, 'source.rgb')
  await ffmpegFile(ffmpeg, ['-protocol_whitelist', 'file', '-f', 'image2', '-pattern_type', 'none', '-i', input, '-frames:v', '1', '-pix_fmt', 'rgba', '-f', 'rawvideo', raw], signal)
  return readFile(raw)
}

export async function repairPngFile(sourcePng: string, width: number, height: number, strokes: RepairStrokes, ffmpeg: string, work: string, signal: AbortSignal): Promise<string> {
  const temp = await mkdtemp(path.join(work, 'inpaint-'))
  const pixels = await decodePixels(ffmpeg, sourcePng, temp, signal)
  const repaired = await inference(pixels, width, height, strokes, ffmpeg, temp, signal)
  const raw = path.join(temp, 'repaired.rgb'), output = path.join(temp, 'repaired.png')
  await writeFile(raw, repaired)
  await ffmpegFile(ffmpeg, ['-f', 'rawvideo', '-pixel_format', 'rgba', '-video_size', `${width}x${height}`, '-i', raw, '-frames:v', '1', output], signal)
  return output
}

export async function repairImagePreview(input: string, media: UpscaleMedia, strokes: RepairStrokes, ffmpeg: string, signal: AbortSignal): Promise<Buffer> {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'mediagrab-inpaint-'))
  try {
    const pixels = await decodePixels(ffmpeg, input, temp, signal)
    const repaired = await inference(pixels, media.width, media.height, strokes, ffmpeg, temp, signal)
    const raw = path.join(temp, 'repaired.rgb'), output = path.join(temp, 'repaired.png')
    await writeFile(raw, repaired)
    await ffmpegFile(ffmpeg, ['-f', 'rawvideo', '-pixel_format', 'rgba', '-video_size', `${media.width}x${media.height}`, '-i', raw, '-frames:v', '1', output], signal)
    if ((await stat(output)).size > 32 * 1024 ** 2) throw new Error('修补预览超过安全大小限制')
    return await readFile(output)
  } finally { await rm(temp, { recursive: true, force: true }) }
}
