import { z } from 'zod'

// Leave margin below common 255-byte filesystem limits; character count alone
// does not protect Chinese/emoji filenames on APFS and other UTF-8 filesystems.
export const upscaleFileNameSchema = z.string().min(1).max(180)
  .refine((s) => Array.from(s.normalize('NFD')).reduce((bytes, c) => { const p = c.codePointAt(0)!; return bytes + (p <= 0x7f ? 1 : p <= 0x7ff ? 2 : p <= 0xffff ? 3 : 4) }, 0) <= 240, '文件名过长，请缩短至 240 UTF-8 字节以内')
  .refine((s) => /^[^/\\\x00-\x1f]+\.mp4$/i.test(s) && !s.startsWith('.'), '请使用普通 MP4 文件名')

export const upscaleCreateSchema = z.object({
  grant: z.string().uuid(),
  fileName: upscaleFileNameSchema,
}).strict()
export type UpscaleCreate = z.infer<typeof upscaleCreateSchema>
export interface UpscaleMedia {
  width: number
  height: number
  fps: string
  frames: number
  duration: number
  audio: boolean
}
export type UpscaleStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted'
export type UpscaleStage = 'queued' | 'probing' | 'decoding' | 'upscaling' | 'encoding' | 'validating' | 'done'
export interface UpscaleTask {
  id: string
  input: string
  output: string
  model: 'realesr-animevideov3-x2'
  status: UpscaleStatus
  stage: UpscaleStage
  completedFrames: number
  media?: UpscaleMedia
  createdAt: number
  updatedAt: number
  error?: { code: string; message: string }
  result?: { path: string; bytes: number; sha256: string; audioSha256?: string }
}
export interface UpscaleCapability {
  available: boolean
  reason?: string
  model: 'realesr-animevideov3-x2'
  platform: string
  limits: { maxSeconds: number; maxFrames: number; maxPixels: number; batch: number; tile: number }
  tools?: Record<string, { path: string; sha256: string; version: string }>
}
export type UpscaleEvent = { type: 'upscale.updated'; task: UpscaleTask }
