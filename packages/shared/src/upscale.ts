import { z } from 'zod'

// Leave margin below common 255-byte filesystem limits; character count alone
// does not protect Chinese/emoji filenames on APFS and other UTF-8 filesystems.
function outputNameSchema(extension: 'mp4' | 'png') {
  const label = extension.toUpperCase()
  return z.string().min(1, '请输入输出文件名').max(180, '文件名过长，请缩短至 180 个字符以内')
    .refine((s) => Array.from(s.normalize('NFD')).reduce((bytes, c) => { const p = c.codePointAt(0)!; return bytes + (p <= 0x7f ? 1 : p <= 0x7ff ? 2 : p <= 0xffff ? 3 : 4) }, 0) <= 240, '文件名过长，请缩短至 240 UTF-8 字节以内')
    .superRefine((s, ctx) => {
      const message = /[/\\]/.test(s) ? '请只填写文件名，不要包含目录或路径分隔符'
        : s.startsWith('.') ? '文件名不能以点开头，请填写普通文件名'
        : s && !new RegExp(`^.+\\.${extension}$`, 'i').test(s) ? `输出格式为 ${label}，请使用 .${extension} 后缀（或不填后缀）`
        : undefined
      if (message) ctx.addIssue({ code: z.ZodIssueCode.custom, message })
    })
}

function fileNameSchema(extension: 'mp4' | 'png') {
  return z.string()
    .refine((s) => !/[\x00-\x1f\x7f]/.test(s), '文件名不能包含换行或控制字符')
    .transform((s) => s.trim())
    .transform((s) => s && !/\.[^./\\]+$/.test(s) ? `${s}.${extension}` : s)
    .pipe(outputNameSchema(extension))
}

export const upscaleFileNameSchema = fileNameSchema('mp4')
export const upscaleImageFileNameSchema = fileNameSchema('png')
export const upscaleKindSchema = z.enum(['video', 'image'])
export type UpscaleKind = z.infer<typeof upscaleKindSchema>

export const repairStrokesSchema = z.array(z.object({
  radius: z.number().finite().min(0.001).max(0.15),
  points: z.array(z.object({ x: z.number().finite().min(0).max(1), y: z.number().finite().min(0).max(1) }).strict()).min(1).max(256),
}).strict()).max(80).superRefine((strokes, context) => {
  if (strokes.reduce((total, stroke) => total + stroke.points.length, 0) > 4096) context.addIssue({ code: z.ZodIssueCode.custom, message: '修补笔画点数超过上限' })
})
export type RepairStrokes = z.infer<typeof repairStrokesSchema>

export const upscaleCreateSchema = z.object({
  grant: z.string().uuid(),
  kind: upscaleKindSchema.default('video'),
  fileName: z.string(),
  repair: repairStrokesSchema.optional(),
}).strict().superRefine((value, ctx) => {
  if (value.repair && value.kind !== 'image') ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['repair'], message: '区域修补仅支持图片' })
  const parsed = (value.kind === 'image' ? upscaleImageFileNameSchema : upscaleFileNameSchema).safeParse(value.fileName)
  if (!parsed.success) for (const issue of parsed.error.issues) ctx.addIssue({ ...issue, path: ['fileName', ...issue.path] })
}).transform((value) => ({
  ...value,
  fileName: (value.kind === 'image' ? upscaleImageFileNameSchema : upscaleFileNameSchema).parse(value.fileName),
}))
export type UpscaleCreate = z.input<typeof upscaleCreateSchema>
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
  kind?: UpscaleKind
  model: 'realesr-animevideov3-x2'
  status: UpscaleStatus
  stage: UpscaleStage
  completedFrames: number
  media?: UpscaleMedia
  createdAt: number
  updatedAt: number
  storageWarning?: string
  error?: { code: string; message: string }
  result?: { path: string; bytes: number; sha256: string; audioSha256?: string }
}
export interface UpscaleCapability {
  available: boolean
  reason?: string
  model: 'realesr-animevideov3-x2'
  platform: string
  imageAvailable?: boolean
  imageReason?: string
  repairAvailable?: boolean
  repairReason?: string
  storageReason?: string
  limits: { maxSeconds: number; maxFrames: number; maxPixels: number; maxImagePixels: number; maxImageSide: number; batch: number; tile: number }
  tools?: Record<string, { path: string; sha256: string; version: string }>
}
export type UpscaleEvent = { type: 'upscale.updated'; task: UpscaleTask }
