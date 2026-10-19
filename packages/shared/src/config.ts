import { z } from 'zod'

/** 视频编码（映射 dash 流的 codecid） */
export const codecSchema = z.enum(['hevc', 'avc', 'av1'])
export type Codec = z.infer<typeof codecSchema>

export const CODEC_ID: Readonly<Record<Codec, number>> = {
  avc: 7,
  hevc: 12,
  av1: 13,
}

/**
 * 下载模式。
 *
 * dash 模式下视频流与音频流本身就是两条独立的流，所以"支持音频下载"与"支持视频下载"
 * 是同一套取流逻辑的三种编排（详见 docs/TECH-DESIGN.md §2）：
 * - `video+audio` 两条都取，用 ffmpeg 合并为 mp4
 * - `video`       只取视频流，remux 为 mp4
 * - `audio`       只取音频流，直接落盘为 m4a（零转码）或转码为 mp3
 */
export const downloadModeSchema = z.enum(['video+audio', 'video', 'audio'])
export type DownloadMode = z.infer<typeof downloadModeSchema>

/**
 * 音频容器。
 * `m4a`：dash 音频流本身即 AAC-in-MP4，改名即可播放 —— **不调用 ffmpeg**，最快无损；
 * `mp3`：需要 ffmpeg 且编译了 libmp3lame。
 */
export const audioContainerSchema = z.enum(['m4a', 'mp3'])
export type AudioContainer = z.infer<typeof audioContainerSchema>

/**
 * 应用配置。
 *
 * 约束（PRD NFR-10 配置诚实）：每个字段都必须被实现，不保留装饰性配置。
 * 所有字段都有默认值，`appConfigSchema.parse({})` 即完整默认配置。
 */
export const appConfigSchema = z.object({
  /** 下载保存目录 */
  savePath: z.string().min(1).default('./download'),
  /** ffmpeg 可执行文件路径；空字符串表示使用 PATH 中的 ffmpeg */
  ffmpegPath: z.string().default(''),
  /** yt-dlp executable; empty means search PATH */
  ytDlpPath: z.string().default(''),
  /** 新建任务时的默认下载模式（页面上仍可临时切换） */
  defaultDownloadMode: downloadModeSchema.default('video+audio'),
  /** 音频容器：仅 mode=audio 时生效 */
  audioContainer: audioContainerSchema.default('m4a'),
  /** mp3 转码码率（kbps）；m4a 路径忽略此值 */
  audioBitrateKbps: z.number().int().min(64).max(320).default(192),
  /** 同时进行的下载任务数 */
  downloadPoolSize: z.number().int().min(1).max(16).default(3),
  /** 单个文件的并发分片数（走 CDN，不受 API 令牌桶约束） */
  mediaThreadCount: z.number().int().min(1).max(16).default(4),
  /** 可重试错误（网络类 / 风控类）的最大重试次数 */
  maxFailRetry: z.number().int().min(0).max(10).default(3),
  /** 视频编码优先级，按顺序尝试 */
  videoCodecPriority: z.array(codecSchema).min(1).default(['hevc', 'avc', 'av1']),
  /** 音质优先级（30280=192K；30250=杜比全景声、30251=Hi-Res 需登录且为大会员） */
  audioQualityPriority: z.array(z.number().int()).min(1).default([30280, 30232, 30216]),
  /** HTTP 服务监听端口 */
  serverPort: z.number().int().min(1).max(65535).default(8787),
  /** 监听地址。安全底线：只监听本机回环，不要改成 0.0.0.0 */
  bindHost: z.string().min(1).default('127.0.0.1'),
  /** 本地访问令牌；非空时 /api/* 需带 Authorization: Bearer <token> */
  accessToken: z.string().default(''),
})

export type AppConfig = z.infer<typeof appConfigSchema>

/** 完整默认配置 */
export function defaultAppConfig(): AppConfig {
  return appConfigSchema.parse({})
}

/**
 * 局部更新：只覆盖传入字段，未传字段保持当前值。
 * 未知字段被 Zod 丢弃（strip），避免脏数据落库。
 */
export function mergeAppConfig(current: AppConfig, patch: unknown): AppConfig {
  const partial = (patch ?? {}) as Partial<AppConfig>
  return appConfigSchema.parse({ ...current, ...partial })
}

/** 供 PATCH /api/config 使用的宽松 schema */
export const appConfigPatchSchema = appConfigSchema.partial()
export type AppConfigPatch = z.infer<typeof appConfigPatchSchema>

/** 只有 mode=audio 且容器为 mp3 时才需要 ffmpeg 转码 */
export function needsFfmpegTranscode(mode: DownloadMode, container: AudioContainer): boolean {
  return mode === 'audio' && container === 'mp3'
}
