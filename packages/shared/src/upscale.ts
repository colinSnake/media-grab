import { z } from 'zod'

// Leave margin below common 255-byte filesystem limits; character count alone
// does not protect Chinese/emoji filenames on APFS and other UTF-8 filesystems.
const mp4FileNameSchema = z.string().min(1, '请输入输出文件名').max(180, '文件名过长，请缩短至 180 个字符以内')
  .refine((s) => Array.from(s.normalize('NFD')).reduce((bytes, c) => { const p = c.codePointAt(0)!; return bytes + (p <= 0x7f ? 1 : p <= 0x7ff ? 2 : p <= 0xffff ? 3 : 4) }, 0) <= 240, '文件名过长，请缩短至 240 UTF-8 字节以内')
  .superRefine((s, ctx) => {
    const message = /[/\\]/.test(s) ? '请只填写文件名，不要包含目录或路径分隔符'
      : s.startsWith('.') ? '文件名不能以点开头，请填写普通文件名'
      : s && !/^.+\.mp4$/i.test(s) ? '输出格式为 MP4，请使用 .mp4 后缀（或不填后缀）'
      : undefined
    if (message) ctx.addIssue({ code: z.ZodIssueCode.custom, message })
  })

export const upscaleFileNameSchema = z.string()
  .refine((s) => !/[\x00-\x1f\x7f]/.test(s), '文件名不能包含换行或控制字符')
  .transform((s) => s.trim())
  // Normalize once in the shared contract so API and direct service calls agree
  // with the UI. An explicit non-MP4 extension is an error, not a rename.
  .transform((s) => s && !/\.[^./\\]+$/.test(s) ? `${s}.mp4` : s)
  .pipe(mp4FileNameSchema)

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
