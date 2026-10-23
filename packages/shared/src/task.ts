import { z } from 'zod'
import { audioContainerSchema, downloadModeSchema } from './config.js'
import { platformSchema } from './platform.js'

export const taskStatusSchema = z.enum([
  'waiting',
  'downloading',
  'merging',
  'success',
  'fail',
  'stopped',
])
export type TaskStatus = z.infer<typeof taskStatusSchema>

/**
 * 任务阶段。
 *
 * 进度必须按阶段分别累计：dash 下视频流与音频流是两次独立传输，
 * 若共用一个计数字段，后一阶段会覆盖前一阶段，表现就是进度条回退。
 */
export const taskPhaseSchema = z.enum(['pending', 'video', 'audio', 'image', 'merge', 'done'])
export type TaskPhase = z.infer<typeof taskPhaseSchema>

export const taskOutputSchema = z.object({ kind: z.enum(['video', 'audio', 'image']), fileName: z.string().min(1) })
export type TaskOutput = z.infer<typeof taskOutputSchema>

export const taskSnapshotSchema = z.object({
  id: z.string(),
  platform: platformSchema.default('bilibili'),
  input: z.string().default(''),
  sourceId: z.string().default(''),
  bvid: z.string(),
  cid: z.number().int(),
  qn: z.number().int().positive().optional(),
  streamId: z.string().min(1).optional(),
  /** 用户选择的清晰度/资源标签，供队列与历史记录展示。 */
  qualityLabel: z.string().min(1).optional(),
  /** 来源 + 输出配置的稳定去重键。旧任务没有此字段时由 taskDedupeKey 回退计算。 */
  dedupeKey: z.string().min(1).optional(),
  title: z.string().default(''),
  status: taskStatusSchema,
  phase: taskPhaseSchema,
  /** 下载模式：决定取哪条流、产物怎么处理 */
  mode: downloadModeSchema.default('video+audio'),
  /** 仅 mode=audio 有意义 */
  audioContainer: audioContainerSchema.optional(),
  /** 各阶段总字节数之和；未知为 0 */
  totalBytes: z.number().int().nonnegative().default(0),
  downloadedBytes: z.number().int().nonnegative().default(0),
  /** 瞬时速度（字节/秒） */
  speedBps: z.number().int().nonnegative().default(0),
  /** 最终产物相对 savePath 的文件名 */
  fileName: z.string().default(''),
  /** 一个任务可同时保存视频和音频；旧任务仍可通过 fileName 读取。 */
  files: z.array(taskOutputSchema).default([]),
  error: z.string().default(''),
  updatedAt: z.number().int(),
})
export type TaskSnapshot = z.infer<typeof taskSnapshotSchema>

/**
 * 同一来源只有在输出配置也相同的情况下才算重复。
 * qn/streamId 被刻意纳入，避免不同分辨率的下载互相覆盖。
 */
export function taskDedupeKey(task: Pick<TaskSnapshot, 'platform' | 'sourceId' | 'input' | 'bvid' | 'cid' | 'qn' | 'streamId' | 'mode' | 'audioContainer'>): string {
  return JSON.stringify([
    task.platform,
    task.sourceId || task.bvid || task.input.trim(),
    task.cid || 0,
    task.mode === 'audio' ? null : task.qn ?? null,
    task.platform === 'bilibili' ? null : task.streamId ?? null,
    task.mode,
    task.mode === 'audio' ? task.audioContainer ?? 'm4a' : null,
  ])
}

/** 总体进度 0–1；总大小未知时返回 0，调用方应显示为不确定进度 */
export function taskProgress(task: Pick<TaskSnapshot, 'totalBytes' | 'downloadedBytes'>): number {
  if (task.totalBytes <= 0) return 0
  return Math.min(1, Math.max(0, task.downloadedBytes / task.totalBytes))
}

export function isCancellable(status: TaskStatus): boolean {
  return status === 'waiting' || status === 'downloading' || status === 'merging'
}

export function isTerminal(status: TaskStatus): boolean {
  return status === 'success' || status === 'fail' || status === 'stopped'
}

export const createTaskRequestSchema = z.object({
  platform: platformSchema.exclude(['unknown']).optional(),
  input: z.string().min(1).optional(),
  bvid: z.string().regex(/^BV[0-9A-Za-z]{10}$/, 'bvid 格式不正确').optional(),
  cid: z.number().int().positive().optional(),
  /** 视频档位；mode=audio 时可省略 */
  qn: z.number().int().positive().optional(),
  streamId: z.string().min(1).optional(),
  qualityLabel: z.string().min(1).optional(),
  mode: downloadModeSchema.default('video+audio'),
  /** 仅 mode=audio 生效 */
  audioContainer: audioContainerSchema.optional(),
  title: z.string().default(''),
}).superRefine((value, ctx) => {
  if (value.input === undefined && (value.bvid === undefined || value.cid === undefined)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: '任务需要 input 或 bvid + cid' })
  }
})
export type CreateTaskRequest = z.infer<typeof createTaskRequestSchema>

export const createTaskResponseSchema = z.object({
  task: taskSnapshotSchema,
  deduplicated: z.boolean(),
})
export type CreateTaskResponse = z.infer<typeof createTaskResponseSchema>

/** WebSocket 推送消息（/api/ws），前后端共用同一个判别联合类型 */
export const wsMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('hello'), serverTime: z.number().int() }),
  z.object({ type: z.literal('task-update'), task: taskSnapshotSchema }),
  z.object({ type: z.literal('task-removed'), id: z.string() }),
])
export type WsMessage = z.infer<typeof wsMessageSchema>
