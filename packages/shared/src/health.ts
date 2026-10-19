import { z } from 'zod'
import { accountSessionSchema } from './bili.js'
import { audioContainerSchema, downloadModeSchema } from './config.js'

/**
 * `GET /api/health` 响应（前后端共用）。
 *
 * M1 起这里不只报"活着"，还要如实暴露免登链路的关键状态：
 * 设备指纹是否落盘、WBI key 是不是当天的、时钟偏差多少、限速参数是多少。
 * 免登模式下出问题（-412 / 签名失败）基本都出在这四项上，把它们摆在健康检查里
 * 比翻日志快得多。注意所有指纹与 key 都只给**摘要**，不给明文（RISK §4）。
 */

export const fingerprintOverviewSchema = z.object({
  present: z.boolean(),
  buvid3Prefix: z.string(),
  buvid4Prefix: z.string(),
  bNut: z.number().nullable(),
  source: z.enum(['store', 'network', 'none']),
  updatedAt: z.number().nullable(),
  ticket: z.object({
    available: z.boolean(),
    /** 只给前缀摘要 */
    ticket: z.string().nullable(),
    expireAt: z.number().nullable(),
    refreshed: z.boolean(),
  }),
})
export type FingerprintOverview = z.infer<typeof fingerprintOverviewSchema>

export const rateLimitStatsSchema = z.object({
  /** 该类别允许的并发上限（RISK §5：playurl ≤2，其它 ≤4，passport =1） */
  limit: z.number().int(),
  active: z.number().int(),
  queued: z.number().int(),
  minIntervalMs: z.number().int(),
})
export type RateLimitStats = z.infer<typeof rateLimitStatsSchema>

export const healthResponseSchema = z.object({
  ok: z.boolean(),
  name: z.string(),
  version: z.string(),
  startedAt: z.string(),
  uptimeSec: z.number().int(),
  runtime: z.object({ node: z.string(), platform: z.string(), pid: z.number().int() }),
  session: accountSessionSchema.extend({ anonymous: z.boolean() }),
  web: z.object({ dist: z.string(), built: z.boolean() }),
  listen: z.object({ host: z.string(), port: z.number().int() }),
  config: z.object({
    savePath: z.string(),
    defaultDownloadMode: downloadModeSchema,
    audioContainer: audioContainerSchema,
    serverPort: z.number().int(),
    serverPortPendingRestart: z.boolean(),
  }),
  bili: z.object({
    db: z.object({ path: z.string(), ok: z.boolean() }),
    device: fingerprintOverviewSchema,
    /** null 表示还没取过 WBI key */
    wbi: z
      .object({
        imgKey: z.string(),
        subKey: z.string(),
        fetchedAt: z.number(),
        sameDay: z.boolean(),
      })
      .nullable(),
    clock: z.object({ offsetMs: z.number().int(), serverNow: z.string() }),
    rateLimit: z.object({
      playurl: rateLimitStatsSchema,
      api: rateLimitStatsSchema,
      passport: rateLimitStatsSchema,
      other: rateLimitStatsSchema,
    }),
  }),
})
export type HealthResponse = z.infer<typeof healthResponseSchema>
