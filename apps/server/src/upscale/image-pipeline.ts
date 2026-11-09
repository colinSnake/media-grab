import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { copyFile, mkdir, open, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import type { UpscaleMedia, UpscaleTask } from '@mediagrab/shared'
import type { RepairStrokes } from '@mediagrab/shared'
import { checkSpace } from './pipeline.js'
import { inspectImage, supportedImage } from './probe.js'
import { limits, type Tools } from './tools.js'
import { Processes } from './process.js'
import { repairPngFile } from './inpainting.js'

const pngSignature = Buffer.from('89504e470d0a1a0a', 'hex')
export function pngSize(png: Buffer): { width: number; height: number } {
  if (png.length < 24 || !png.subarray(0, 8).equals(pngSignature) || png.toString('ascii', 12, 16) !== 'IHDR') throw new Error('超分引擎未生成有效 PNG 图片')
  const width = png.readUInt32BE(16), height = png.readUInt32BE(20)
  if (!width || !height) throw new Error('PNG 图片尺寸无效')
  return { width, height }
}

async function pngFileSize(file: string): Promise<{ width: number; height: number }> {
  const handle = await open(file, 'r')
  try {
    const header = Buffer.alloc(24)
    const { bytesRead } = await handle.read(header, 0, header.length, 0)
    if (bytesRead < header.length) throw new Error('PNG 图片头不完整')
    return pngSize(header)
  } finally { await handle.close() }
}

async function hashFile(file: string, signal: AbortSignal): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file, { signal })) hash.update(chunk)
  return hash.digest('hex')
}

export async function imagePipeline(
  input: string,
  work: string,
  tools: Tools,
  processes: Processes,
  update: (stage: UpscaleTask['stage'], completed: number, media?: UpscaleMedia) => void,
  repair?: RepairStrokes,
): Promise<NonNullable<UpscaleTask['result']>> {
  update('probing', 0)
  const media = supportedImage(await inspectImage(input, tools, processes))
  await checkSpace(work, media, (await stat(input)).size)

  const decoded = path.join(work, 'in'), enhanced = path.join(work, 'out')
  await mkdir(decoded); await mkdir(enhanced)
  const sourcePng = path.join(decoded, 'input.png')
  const candidate = path.join(enhanced, 'input.png')
  update('decoding', 0, media)
  await processes.run(tools.ffmpeg, [
    '-v', 'error', '-xerror', '-nostdin', '-threads', '2',
    '-protocol_whitelist', 'file', '-f', 'image2', '-pattern_type', 'none', '-i', input,
    '-map', '0:v:0', '-frames:v', '1', '-an', '-sn', '-c:v', 'png', '-threads', '1', sourcePng,
  ])
  const decodedStat = await stat(sourcePng)
  if (decodedStat.size > 128 * 1024 ** 2) throw new Error('解码后的图片超过安全大小限制')
  const decodedInfo = await pngFileSize(sourcePng)
  if (decodedInfo.width !== media.width || decodedInfo.height !== media.height) throw new Error('图片解码尺寸与探测结果不一致')

  let upscaleInput = decoded
  if (repair) {
    const repairedDirectory = path.join(work, 'repaired')
    await mkdir(repairedDirectory)
    const repairedPng = await repairPngFile(sourcePng, decodedInfo.width, decodedInfo.height, repair, tools.ffmpeg, work, processes.signal)
    await copyFile(repairedPng, path.join(repairedDirectory, 'input.png'))
    upscaleInput = repairedDirectory
  }

  update('upscaling', 0, media)
  await processes.run(tools.engine, [
    '-i', upscaleInput, '-o', enhanced, '-m', tools.models, '-n', 'realesr-animevideov3',
    '-s', '2', '-t', String(limits.tile), '-j', '1:1:1', '-f', 'png',
  ], 1024 * 1024)
  update('validating', 0, media)
  const candidateStat = await stat(candidate)
  if (candidateStat.size > 256 * 1024 ** 2) throw new Error('超分结果超过安全大小限制')
  const outputInfo = await pngFileSize(candidate)
  if (outputInfo.width !== media.width * 2 || outputInfo.height !== media.height * 2) throw new Error('超分结果尺寸不是精确 2×')
  await processes.run(tools.ffmpeg, ['-v', 'error', '-xerror', '-nostdin', '-protocol_whitelist', 'file', '-f', 'image2', '-pattern_type', 'none', '-i', candidate, '-frames:v', '1', '-f', 'null', '-'])
  await rm(decoded, { recursive: true })
  update('done', 1, media)
  return { path: candidate, bytes: candidateStat.size, sha256: await hashFile(candidate, processes.signal) }
}
