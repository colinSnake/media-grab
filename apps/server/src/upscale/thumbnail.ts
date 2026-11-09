import { Processes } from './process.js'
import { localInput } from './probe.js'
import type { UpscaleKind } from '@mediagrab/shared'

/** Decode only the first video frame, never seek into or rewrite the source. */
export async function firstFrame(ffmpeg: string, input: string, signal: AbortSignal, kind: UpscaleKind = 'video'): Promise<Buffer> {
  const processes = new Processes(signal)
  const sourceArgs = kind === 'image' ? ['-protocol_whitelist', 'file', '-f', 'image2', '-pattern_type', 'none'] : localInput
  const { child, done } = processes.start(ffmpeg, ['-v', 'error', '-nostdin', ...sourceArgs, '-i', input, '-map', '0:v:0', '-frames:v', '1', '-an', '-sn', '-vf', 'scale=320:180:force_original_aspect_ratio=decrease,format=rgb24', '-c:v', 'png', '-threads', '1', '-f', 'image2pipe', 'pipe:1'], { timeoutMs: 15_000 })
  child.stdin.end()
  const chunks: Buffer[] = []
  let bytes = 0, overflow = false
  child.stdout.on('data', (chunk: Buffer) => {
    bytes += chunk.length
    if (bytes <= 512 * 1024) chunks.push(chunk)
    else if (!overflow) { overflow = true; child.kill('SIGTERM') }
  })
  try { await done } catch (error) {
    if (overflow) throw new Error('封面超出大小限制', { cause: error })
    throw error
  }
  if (overflow) throw new Error('封面超出大小限制')
  const image = Buffer.concat(chunks)
  if (!image.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) throw new Error('未能读取素材预览')
  return image
}
