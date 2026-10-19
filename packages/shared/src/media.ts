import { z } from 'zod'
import { platformSchema } from './platform.js'

export const mediaStreamKindSchema = z.enum(['video', 'audio', 'image'])
export type MediaStreamKind = z.infer<typeof mediaStreamKindSchema>

export const mediaStreamSchema = z.object({
  id: z.string().min(1),
  kind: mediaStreamKindSchema,
  combined: z.boolean().default(false),
  label: z.string().default(''),
  url: z.string().url(),
  backupUrls: z.array(z.string().url()).default([]),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  codecs: z.string().optional(),
  mimeType: z.string().optional(),
  bitrate: z.number().int().nonnegative().optional(),
  sizeBytes: z.number().int().nonnegative().optional(),
  available: z.boolean().default(true),
  reason: z.string().default(''),
})
export type MediaStream = z.infer<typeof mediaStreamSchema>

export const mediaParseResultSchema = z.object({
  platform: platformSchema,
  input: z.string(),
  id: z.string(),
  title: z.string().default(''),
  authorName: z.string().default(''),
  cover: z.string().url().or(z.literal('')).default(''),
  durationSec: z.number().int().nonnegative().default(0),
  streams: z.array(mediaStreamSchema),
  itemCount: z.number().int().positive().default(1),
  capabilities: z.object({
    video: z.boolean(),
    audio: z.boolean(),
    image: z.boolean(),
    download: z.boolean(),
  }),
})
export type MediaParseResult = z.infer<typeof mediaParseResultSchema>

export const mediaParseRequestSchema = z.object({
  input: z.string().min(1, '请输入媒体链接'),
})
export type MediaParseRequest = z.infer<typeof mediaParseRequestSchema>
