import type { UpscaleMedia } from '@mediagrab/shared'
import { limits, type Tools } from './tools.js'
import { Processes } from './process.js'

// Force the MOV/MP4 demuxer, disable external data references and network protocols.
export const localInput = ['-protocol_whitelist', 'file,pipe', '-f', 'mov', '-enable_drefs', '0', '-use_absolute_path', '0', '-threads', '2']
// Half-millisecond input rounding plus ffprobe's decimal-print rounding.
const inputTimelineTolerance = 0.000501
export interface ProbeStream {
  codec_type?: string; codec_name?: string; pix_fmt?: string; width?: number; height?: number
  r_frame_rate?: string; avg_frame_rate?: string; nb_read_frames?: string; nb_frames?: string; duration?: string
  color_transfer?: string; color_primaries?: string; color_space?: string; sample_aspect_ratio?: string
  field_order?: string; color_range?: string; start_time?: string; channels?: number; sample_rate?: string
  tags?: Record<string, string>; side_data_list?: Array<{ rotation?: number; side_data_type?: string }>
}
interface Probe { streams: ProbeStream[]; format: { duration?: string; format_name?: string }; chapters?: unknown[] }
export function rate(value: string): number {
  const [n, d = '1'] = value.split('/')
  return Number(n) / Number(d)
}
export function supportedMedia(probe: Probe): UpscaleMedia {
  const videos = probe.streams.filter((s) => s.codec_type === 'video')
  const audios = probe.streams.filter((s) => s.codec_type === 'audio')
  if (videos.length !== 1 || audios.length > 1 || probe.streams.length !== videos.length + audios.length || (probe.chapters?.length ?? 0) > 0) throw new Error('仅支持单视频轨、无音轨或单 AAC 音轨；不支持字幕、章节、数据或多轨')
  const v = videos[0]!
  if (v.codec_name !== 'h264' || !['yuv420p', 'yuvj420p'].includes(v.pix_fmt ?? '')) throw new Error('首版仅支持 8-bit H.264 / 4:2:0 的 SDR MP4')
  if ((v.color_transfer && !['bt709', 'unknown'].includes(v.color_transfer)) || (v.color_primaries && !['bt709', 'unknown'].includes(v.color_primaries)) || (v.color_space && !['bt709', 'bt470bg', 'smpte170m', 'unknown'].includes(v.color_space))) throw new Error('不支持 HDR 或未知色彩系统')
  if (v.side_data_list?.some((s) => s.side_data_type && !['ICC Profile'].includes(s.side_data_type))) throw new Error('不支持 HDR、显示矩阵或其它附加视频元数据')
  if (v.field_order && !['progressive', 'unknown'].includes(v.field_order)) throw new Error('不支持隔行视频')
  if ((v.tags?.rotate && Number(v.tags.rotate) !== 0) || v.side_data_list?.some((s) => s.side_data_type === 'Display Matrix' || (s.rotation ?? 0) !== 0)) throw new Error('暂不支持旋转/显示矩阵元数据')
  if (v.sample_aspect_ratio && !['1:1', 'N/A'].includes(v.sample_aspect_ratio)) throw new Error('仅支持方形像素')
  const width = v.width ?? 0, height = v.height ?? 0
  if (width < 64 || height < 64 || width > 1920 || height > 1080 || width % 2 || height % 2 || width * height > limits.maxPixels) throw new Error('尺寸须为偶数，64×64 至 1920×1080')
  const fps = v.r_frame_rate ?? '0/0', frames = Number(v.nb_read_frames ?? v.nb_frames), duration = Number(probe.format.duration)
  if (!Number.isInteger(frames) || frames < 1 || frames > limits.maxFrames || !Number.isFinite(duration) || duration <= 0 || duration > limits.maxSeconds) throw new Error('无法确认帧数/时长或超过安全上限（10 分钟 / 36000 帧）')
  const nominalFps = rate(fps), averageFps = rate(v.avg_frame_rate ?? '0/0')
  if (!Number.isFinite(nominalFps) || nominalFps < 1 || nominalFps > 60 || !Number.isFinite(averageFps) || averageFps <= 0) throw new Error('仅支持 1–60 fps 恒定帧率视频')
  // MP4 tick rounding can make avg_frame_rate slightly different from the actual
  // frame grid (e.g. 738 frames / 24.5999375 s = 30.000076 fps). Bound the
  // disagreement over the ENTIRE clip, not with a fixed fps delta that permits
  // long-clip drift. r_frame_rate is only a candidate: timeline() still verifies
  // every decoded frame before granting or processing the task.
  if (Math.abs(frames / nominalFps - frames / averageFps) > inputTimelineTolerance) throw new Error('视频标称与平均帧率不一致，暂不支持可变帧率视频')
  if (!Number.isFinite(Number(v.start_time)) || !Number.isFinite(Number(v.duration)) || Math.abs(Number(v.start_time)) > 0.001 || Math.abs(Number(v.duration) - frames / rate(fps)) > 0.03) throw new Error('暂不支持非零起点或不完整视频时间线')
  if (audios[0] && (audios[0].codec_name !== 'aac' || ![1, 2].includes(Number(audios[0].channels)) || !Number.isFinite(Number(audios[0].start_time)) || Math.abs(Number(audios[0].start_time)) > 0.001 || !Number.isFinite(Number(audios[0].duration)) || Math.abs(Number(audios[0].duration) - frames / rate(fps)) > 0.1)) throw new Error('仅支持起点为零、时长匹配的单/双声道 AAC 音频，不静默删除或转码音频')
  return { width, height, fps, frames, duration: frames / rate(fps), audio: audios.length === 1 }
}
export async function inspect(file: string, tools: Tools, processes: Processes, output = false): Promise<Probe> {
  const args = ['-v', 'error', ...localInput, '-show_streams', '-show_format', '-show_chapters', '-of', 'json', file]
  const preliminary = JSON.parse(await processes.run(tools.ffprobe, args)) as Probe
  const bounded = structuredClone(preliminary)
  if (output) for (const stream of bounded.streams) if (stream.codec_type === 'video') {
    stream.width = (stream.width ?? 0) / 2; stream.height = (stream.height ?? 0) / 2
  }
  // Reject oversized/unknown/unsupported sources before the expensive full decode count.
  supportedMedia(bounded)
  return JSON.parse(await processes.run(tools.ffprobe, ['-count_frames', ...args])) as Probe
}
export async function timeline(file: string, media: UpscaleMedia, tools: Tools, processes: Processes, requireDts = false): Promise<void> {
  const data = JSON.parse(await processes.run(tools.ffprobe, ['-v', 'error', ...localInput, '-select_streams', 'v:0', '-show_frames', '-show_entries', 'frame=best_effort_timestamp_time,pkt_dts_time', '-of', 'json', file])) as { frames: Array<{ best_effort_timestamp_time?: string; pkt_dts_time?: string }> }
  if (data.frames.length !== media.frames) throw new Error('解码帧数不匹配')
  // Some otherwise-CFR downloads round PTS to milliseconds (e.g. 24 fps uses
  // alternating 41/42 ms intervals). Allow at most half a millisecond plus
  // ffprobe's decimal-print rounding on input, measured against the global
  // frame grid, not the previous frame: drift/dropped frames must still fail.
  // Generated output and the zero start retain the stricter 0.1 ms check.
  const strictTolerance = 0.0001
  const fps = rate(media.fps)
  let lastDts = -Infinity, lastPts = -Infinity
  for (const [i, frame] of data.frames.entries()) {
    const pts = Number(frame.best_effort_timestamp_time)
    const tolerance = requireDts || i === 0 ? strictTolerance : inputTimelineTolerance
    if (!Number.isFinite(pts) || pts <= lastPts || Math.abs(pts - i / fps) > tolerance) throw new Error(`检测到 VFR、非零起点或异常 PTS 时间线（第 ${i + 1} 帧）`)
    lastPts = pts
    if (frame.pkt_dts_time !== undefined) {
      const dts = Number(frame.pkt_dts_time)
      if (!Number.isFinite(dts) || dts <= lastDts || (requireDts && Math.abs(dts - pts) > strictTolerance)) throw new Error('DTS 时间线不匹配')
      lastDts = dts
    } else if (requireDts) throw new Error('输出缺少 DTS')
  }
}
export async function audioHash(file: string, tools: Tools, processes: Processes): Promise<string> {
  const hash = await processes.run(tools.ffmpeg, ['-v', 'error', ...localInput, '-i', file, '-map', '0:a:0', '-c:a', 'copy', '-f', 'hash', '-hash', 'sha256', 'pipe:1'], 1024)
  if (!/^SHA256=[a-f0-9]{64}\s*$/.test(hash)) throw new Error('音频数据校验失败')
  return hash.trim()
}
export interface AudioPacketTime { pts_time: string; dts_time: string; duration_time: string }
export async function audioTimeline(file: string, tools: Tools, processes: Processes): Promise<AudioPacketTime[]> {
  const json = await processes.run(tools.ffprobe, [
    '-v', 'error', ...localInput, '-select_streams', 'a:0', '-show_packets',
    '-show_entries', 'packet=pts_time,dts_time,duration_time', '-of', 'json', file,
  ], 8 * 1024 * 1024)
  const { packets } = JSON.parse(json) as { packets?: AudioPacketTime[] }
  if (!packets?.length || packets.some((packet) => ![packet.pts_time, packet.dts_time, packet.duration_time].every((value) => Number.isFinite(Number(value))))) throw new Error('AAC 音频包时间线不完整')
  return packets
}
export function sameAudioTimeline(expected: AudioPacketTime[], actual: AudioPacketTime[]): boolean {
  return expected.length === actual.length && expected.every((packet, i) => {
    const candidate = actual[i]!
    return Math.abs(Number(packet.pts_time) - Number(candidate.pts_time)) <= 0.00001
      && Math.abs(Number(packet.dts_time) - Number(candidate.dts_time)) <= 0.00001
      && Math.abs(Number(packet.duration_time) - Number(candidate.duration_time)) <= 0.00001
  })
}
