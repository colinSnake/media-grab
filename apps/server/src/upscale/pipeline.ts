import { createReadStream } from 'node:fs'
import { mkdir, readFile, rm, stat, statfs, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import type { Readable, Writable } from 'node:stream'
import type { UpscaleMedia, UpscaleStage, UpscaleTask } from '@mediagrab/shared'
import { audioHash, audioTimeline, inspect, localInput, rate, sameAudioTimeline, supportedMedia, timeline } from './probe.js'
import { Processes } from './process.js'
import { limits, type Tools } from './tools.js'

/** PNG image2pipe splitter: chunk framing, not searching for an accidental IEND byte sequence. */
export async function* pngFrames(stream: Readable): AsyncGenerator<Buffer> {
  let pending: Buffer<ArrayBufferLike> = Buffer.alloc(0)
  let chunks: Buffer[] = [], bytes = 0, signature = true
  for await (const raw of stream) {
    pending = Buffer.concat([pending, raw as Buffer])
    for (;;) {
      if (signature) {
        if (pending.length < 8) break
        if (pending.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new Error('PNG 解码帧头无效')
        chunks = [pending.subarray(0, 8)]; bytes = 8; pending = pending.subarray(8); signature = false
      }
      if (pending.length < 8) break
      const length = pending.readUInt32BE(0) + 12
      if (length > 64 * 1024 * 1024 || bytes + length > 64 * 1024 * 1024) throw new Error('PNG 帧超出安全上限')
      if (pending.length < length) break
      const chunk = pending.subarray(0, length)
      chunks.push(chunk); bytes += length; pending = pending.subarray(length)
      if (chunk.toString('ascii', 4, 8) === 'IEND') { yield Buffer.concat(chunks); chunks = []; bytes = 0; signature = true }
    }
  }
  if (pending.length || !signature) throw new Error('解码器返回不完整 PNG 帧')
}
async function write(stream: Writable, data: Buffer): Promise<void> {
  await new Promise<void>((resolve, reject) => stream.write(data, (error) => error ? reject(error) : resolve()))
}
export async function videoHash(file: string, signal?: AbortSignal): Promise<string> {
  const hash = createHash('sha256')
  for await (const data of createReadStream(file, { signal })) hash.update(data)
  return hash.digest('hex')
}
export function requiredSpace(media: UpscaleMedia, sourceBytes: number): number {
  // 12 input/output PNGs + decoder/encoder buffers; conservative 2 candidates at 80 Mbps.
  return Math.ceil(512 * 1024 ** 2 + Math.min(limits.batch, media.frames) * media.width * media.height * 5 * 4 + Math.max(sourceBytes * 4, media.duration * 10_000_000) * 2)
}
export function ensureSpace(availableBytes: number, media: UpscaleMedia, sourceBytes: number): void {
  if (!Number.isFinite(availableBytes) || availableBytes < requiredSpace(media, sourceBytes)) throw Object.assign(new Error('输出卷可用空间不足（包括候选视频和有界临时帧）'), { code: 'ENOSPC' })
}
export async function checkSpace(directory: string, media: UpscaleMedia, sourceBytes: number): Promise<void> {
  const fs = await statfs(directory)
  ensureSpace(fs.bavail * fs.bsize, media, sourceBytes)
}
export async function pipeline(input: string, work: string, tools: Tools, processes: Processes, update: (stage: UpscaleStage, completed: number, media?: UpscaleMedia) => void): Promise<NonNullable<UpscaleTask['result']>> {
  update('probing', 0)
  const media = supportedMedia(await inspect(input, tools, processes))
  await timeline(input, media, tools, processes)
  await checkSpace(work, media, (await stat(input)).size)
  update('decoding', 0, media)
  const originalAudio = media.audio ? await audioHash(input, tools, processes) : undefined
  const originalAudioTimeline = media.audio ? await audioTimeline(input, tools, processes) : undefined
  const decoded = path.join(work, 'in'), enhanced = path.join(work, 'out'), candidate = path.join(work, 'candidate.mp4')
  await mkdir(decoded); await mkdir(enhanced)
  const decoder = processes.start(tools.ffmpeg, ['-v', 'error', '-xerror', ...localInput, '-i', input, '-map', '0:v:0', '-an', '-fps_mode', 'passthrough', '-threads', '2', '-c:v', 'png', '-f', 'image2pipe', 'pipe:1'], { timeoutMode: 'idle' })
  decoder.child.stdin.end()
  const encoder = processes.start(tools.ffmpeg, ['-v', 'error', '-xerror', '-n', '-threads', '2', '-probesize', '32', '-analyzeduration', '0', '-f', 'image2pipe', '-framerate', media.fps, '-vcodec', 'png', '-i', 'pipe:0', ...localInput, '-i', input, '-map', '0:v:0', ...(media.audio ? ['-map', '1:a:0', '-c:a', 'copy'] : ['-an']), '-map_metadata', '-1', '-map_chapters', '-1', '-vf', 'scale=in_range=full:out_range=tv:out_color_matrix=bt709,setsar=1', '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-maxrate', '80M', '-bufsize', '160M', '-x264-params', 'rc-lookahead=8:sync-lookahead=0', '-threads', '4', '-bf', '0', '-pix_fmt', 'yuv420p', '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-movflags', '+faststart', candidate], { timeoutMode: 'idle' })
  encoder.child.stdout.resume()
  // Decode/encode can wait on each other for hours while AI batches make progress.
  // Renew only on actual frame/batch progress, never on an unconditional interval.
  const heartbeat = (): void => { decoder.heartbeat(); encoder.heartbeat() }
  let completed = 0, batch = 0
  const flush = async (): Promise<void> => {
    processes.signal.throwIfAborted()
    await checkSpace(work, media, (await stat(input)).size)
    heartbeat()
    update('upscaling', completed)
    await processes.run(tools.engine, ['-i', decoded, '-o', enhanced, '-m', tools.models, '-n', 'realesr-animevideov3', '-s', '2', '-t', String(limits.tile), '-j', '1:1:1', '-f', 'png'], 1024 * 1024)
    heartbeat()
    update('encoding', completed)
    for (let i = 0; i < batch; i++) {
      const name = `${String(i).padStart(6, '0')}.png`
      const frame = await readFile(path.join(enhanced, name))
      if (frame.readUInt32BE(16) !== media.width * 2 || frame.readUInt32BE(20) !== media.height * 2) throw new Error('引擎输出不是精确 2× 帧')
      try { await write(encoder.child.stdin, frame) } catch (error) { await encoder.done; throw error }
      heartbeat()
      completed++
      update('encoding', completed)
      await rm(path.join(decoded, name)); await rm(path.join(enhanced, name))
    }
    batch = 0
  }
  for await (const frame of pngFrames(decoder.child.stdout)) {
    processes.signal.throwIfAborted()
    if (completed + batch >= media.frames) throw new Error('解码帧超出探测帧数')
    heartbeat()
    update('decoding', completed)
    await writeFile(path.join(decoded, `${String(batch).padStart(6, '0')}.png`), frame, { flag: 'wx' })
    if (++batch === limits.batch) await flush()
  }
  await decoder.done
  if (batch) await flush()
  encoder.child.stdin.end()
  await encoder.done
  if (completed !== media.frames) throw new Error('处理帧数不匹配')
  update('validating', completed)
  const outputProbe = await inspect(candidate, tools, processes, true)
  // Output is allowed up to 4K, unlike input. Check the rest with normalized dimensions.
  const video = outputProbe.streams.find((s) => s.codec_type === 'video')!
  if (video.width !== media.width * 2 || video.height !== media.height * 2) throw new Error('成片尺寸不匹配')
  video.width = media.width; video.height = media.height
  const out = supportedMedia(outputProbe)
  if (out.frames !== media.frames || Math.abs(rate(out.fps) - rate(media.fps)) > 0.00001 || out.audio !== media.audio || Math.abs(out.duration - media.duration) > 0.001) throw new Error('成片帧数、帧率、时长或音轨不匹配')
  await timeline(candidate, media, tools, processes, true)
  await processes.run(tools.ffmpeg, ['-v', 'error', '-xerror', ...localInput, '-i', candidate, '-f', 'null', '-'], 1024)
  const resultAudio = media.audio ? await audioHash(candidate, tools, processes) : undefined
  if (resultAudio !== originalAudio) throw new Error('AAC 压缩数据不一致')
  if (originalAudioTimeline && !sameAudioTimeline(originalAudioTimeline, await audioTimeline(candidate, tools, processes))) throw new Error('AAC 音频包时间线不一致')
  return { path: candidate, bytes: (await stat(candidate)).size, sha256: await videoHash(candidate, processes.signal), ...(resultAudio ? { audioSha256: resultAudio } : {}) }
}
