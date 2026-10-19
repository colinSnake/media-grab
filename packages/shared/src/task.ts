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
export const taskPhaseSchema = z.enum(['pending', 'video', 'audio', 'merge', 'done'])
export type TaskPhase = z.infer<typeof taskPhaseSchema>

export const taskSnapshotSchema = z.object({
  id: z.string(),
  platform: platformSchema.default('bilibili'),
  input: z.string().default(''),
  sourceId: z.string().default(''),
  bvid: z.string(),
  cid: z.number().int(),
  qn: z.number().int().positive().optional(),
  streamId: z.string().min(1).optional(),
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
  error: z.string().default(''),
  updatedAt: z.number().int(),
})
export type TaskSnapshot = z.infer<typeof taskSnapshotSchema>

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
  platform: platformSchema.default('bilibili'),
  input: z.string().min(1).optional(),
  bvid: z.string().regex(/^BV[0-9A-Za-z]{10}$/, 'bvid 格式不正确').optional(),
  cid: z.number().int().positive().optional(),
  /** 视频档位；mode=audio 时可省略 */
  qn: z.number().int().positive().optional(),
  streamId: z.string().min(1).optional(),
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

/** WebSocket 推送消息（/api/ws），前后端共用同一个判别联合类型 */
export const wsMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('hello'), serverTime: z.number().int() }),
  z.object({ type: z.literal('task-update'), task: taskSnapshotSchema }),
  z.object({ type: z.literal('task-removed'), id: z.string() }),
])
export type WsMessage = z.infer<typeof wsMessageSchema>
