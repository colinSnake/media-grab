import path from 'node:path'
import { z } from 'zod'

const absolute = z.string().min(1).max(4096).refine(path.isAbsolute)
const timestamp = z.number().finite().nonnegative()
const digest = z.string().regex(/^[a-f0-9]{64}$/)
// SQLite snapshots are not a trusted type assertion: a damaged/old row must not
// prevent downloads or the desktop core from starting, nor drive unsafe cleanup.
export const upscaleRecordSchema = z.object({
  task: z.object({
    id: z.string().uuid(), input: absolute, output: absolute,
    model: z.literal('realesr-animevideov3-x2'),
    status: z.enum(['queued', 'running', 'succeeded', 'failed', 'cancelled', 'interrupted']),
    stage: z.enum(['queued', 'probing', 'decoding', 'upscaling', 'encoding', 'validating', 'done']),
    completedFrames: z.number().int().min(0).max(36000),
    media: z.object({
      width: z.number().int().min(64).max(1920), height: z.number().int().min(64).max(1080),
      fps: z.string().regex(/^\d+(?:\/\d+)?$/), frames: z.number().int().min(1).max(36000),
      duration: z.number().finite().positive().max(600), audio: z.boolean(),
    }).optional(),
    createdAt: timestamp, updatedAt: timestamp,
    error: z.object({ code: z.string(), message: z.string() }).optional(),
    result: z.object({ path: absolute, bytes: z.number().int().positive(), sha256: digest, audioSha256: z.string().regex(/^SHA256=[a-f0-9]{64}$/).optional() }).optional(),
  }),
  identity: z.string().min(1), work: absolute.optional(),
}).superRefine((record, context) => {
  if (record.work && !path.basename(record.work).startsWith(`.mediagrab-upscale-${record.task.id}-`)) context.addIssue({ code: z.ZodIssueCode.custom, path: ['work'], message: '临时目录不属于任务' })
})
