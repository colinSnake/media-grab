import { z } from 'zod'
import {
  accountSessionSchema,
  audioAvailabilitySchema,
  qualityAvailabilitySchema,
} from './bili.js'

/* --------------------------------- 输入归一化 -------------------------------- */

/** BV 号格式：BV + 10 位 Base58 字符（大小写敏感） */
export const BV_PATTERN: RegExp = /^BV[0-9A-Za-z]{10}$/

/** BV 号校验（不访问网络） */
export const bvidSchema = z.string().regex(BV_PATTERN, 'bvid 格式不正确')

/** av 号校验：正整数 */
export const avidSchema = z.number().int().positive()

/** 归一化后的用户输入 */
export type BiliInput =
  | { kind: 'bvid'; bvid: string; page?: number }
  | { kind: 'avid'; avid: number; page?: number }
  /** b23.tv 短链，需要出网解析真实地址（本项目只在服务端做） */
  | { kind: 'short'; url: string; page?: number }

/** 输入归一化结果；失败时 `reason` 为可直接展示给用户的中文文案 */
export type ParseInputResult = { ok: true; value: BiliInput } | { ok: false; reason: string }

/** 空输入提示 */
const REASON_EMPTY = '请输入视频链接、BV 号或 av 号'
/** 无法识别为 URL 时的提示 */
const REASON_UNRECOGNIZED = '无法识别的输入，支持 BV 号 / av 号 / 视频链接 / b23.tv 短链'
/** bilibili.com 链接里没有视频 ID 时的提示 */
const REASON_NO_VIDEO_ID = '链接里没有找到视频 ID（形如 /video/BV... 或 /video/av...）'

/**
 * 只声明本项目用到的 URL 能力。
 * packages/shared 的 tsconfig 只引 ES2023 lib、也没有 @types/node，
 * 为了一个全局构造函数去新增依赖不划算，这里做结构化声明。
 */
interface UrlLike {
  hostname: string
  pathname: string
  searchParams: { get(name: string): string | null }
  toString(): string
}

/** Node 20+ / 浏览器都提供全局 URL；缺失时退化为「无法识别」而不是抛异常 */
const UrlCtor = (globalThis as unknown as { URL?: new (input: string) => UrlLike }).URL

/** 无 scheme 时，仅当开头像主机名才补 https://，避免把「乱码」punycode 成域名 */
function looksLikeHost(input: string): boolean {
  const host = input.split(/[/?#]/, 1)[0] ?? ''
  return /^[A-Za-z0-9.-]+(?::\d+)?$/.test(host)
}

function toUrl(input: string): UrlLike | undefined {
  if (typeof UrlCtor !== 'function') return undefined
  try {
    return new UrlCtor(input)
  } catch {
    // 无 scheme 的输入（如 bilibili.com/video/BV...）落到这里
  }
  if (!looksLikeHost(input)) return undefined
  try {
    return new UrlCtor(`https://${input}`)
  } catch {
    return undefined
  }
}

/**
 * 聊天工具、Markdown 和富文本复制有时会把查询串里的 `&` 写成 `\&`。
 * 这不会改变视频 ID，但会让用户粘贴的 URL 不是原始链接；在 URL 解析前统一还原。
 */
function normalizeCopiedUrl(input: string): string {
  return input.replace(/\\(?=[&#?])/g, '')
}

/** 取 `?p=` 参数：仅接受正整数，其它一律 undefined */
function pageOf(url: UrlLike): number | undefined {
  const raw = url.searchParams.get('p')
  if (raw === null) return undefined
  const page = Number(raw)
  return Number.isInteger(page) && page > 0 ? page : undefined
}

/** hostname 是否为给定域本身或其子域 */
function isHost(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`)
}

/**
 * 把用户输入归一化为 {@link BiliInput}；**不访问网络**。
 *
 * 支持：纯 BV 号、纯 av 号（大小写不敏感）、bilibili.com 视频链接（可省略 scheme，
 * 兼容 www/m 等子域与 `?p=` 分P）、b23.tv 短链（只识别为 `kind:'short'`，
 * 由服务端出网解析真实地址）。
 *
 * @param raw 用户原始输入
 */
export function parseBiliInput(raw: string): ParseInputResult {
  const input = normalizeCopiedUrl(raw.trim())
  if (input.length === 0) return { ok: false, reason: REASON_EMPTY }

  if (BV_PATTERN.test(input)) return { ok: true, value: { kind: 'bvid', bvid: input } }

  const av = /^av(\d+)$/i.exec(input)
  if (av?.[1] !== undefined) {
    return { ok: true, value: { kind: 'avid', avid: Number(av[1]) } }
  }

  const url = toUrl(input)
  if (!url) return { ok: false, reason: REASON_UNRECOGNIZED }

  const host = url.hostname.toLowerCase()
  const page = pageOf(url)

  if (isHost(host, 'b23.tv')) {
    return { ok: true, value: { kind: 'short', url: url.toString(), page } }
  }

  if (isHost(host, 'bilibili.com')) {
    const bvid = /\/video\/(BV[0-9A-Za-z]{10})/.exec(url.pathname)
    if (bvid?.[1] !== undefined) {
      return { ok: true, value: { kind: 'bvid', bvid: bvid[1], page } }
    }
    const avid = /\/video\/av(\d+)/i.exec(url.pathname)
    if (avid?.[1] !== undefined) {
      return { ok: true, value: { kind: 'avid', avid: Number(avid[1]), page } }
    }
    return { ok: false, reason: REASON_NO_VIDEO_ID }
  }

  return {
    ok: false,
    reason: `不支持的站点：${host}（仅支持 bilibili.com / b23.tv）`,
  }
}

/* ------------------------------- 接口响应 schema ------------------------------ */

/** 分P信息（B站对缺失字段可能返回 null，统一收敛） */
export const videoPageSchema = z.object({
  cid: z.number().int(),
  page: z.number().int(),
  part: z
    .string()
    .nullish()
    .transform((value) => value ?? ''),
  duration: z
    .number()
    .int()
    .nullish()
    .transform((value) => value ?? 0),
})
export type VideoPage = z.infer<typeof videoPageSchema>

/** GET https://api.bilibili.com/x/web-interface/view */
export const videoViewSchema = z.object({
  code: z.number(),
  message: z.string().optional(),
  data: z
    .object({
      bvid: z.string(),
      aid: z.number(),
      cid: z.number(),
      title: z
        .string()
        .nullish()
        .transform((value) => value ?? ''),
      pic: z
        .string()
        .nullish()
        .transform((value) => value ?? ''),
      duration: z
        .number()
        .nullish()
        .transform((value) => value ?? 0),
      owner: z.object({
        mid: z.number(),
        name: z
          .string()
          .nullish()
          .transform((value) => value ?? ''),
      }),
      pages: z
        .array(videoPageSchema)
        .nullish()
        .transform((value) => value ?? []),
    })
    .optional(),
})
export type VideoView = z.infer<typeof videoViewSchema>

/** 单条音视频流的摘要（前后端共用；地址已归一化到 `url`） */
export const streamSummarySchema = z.object({
  id: z.number().int(),
  codecid: z.number().int().optional(),
  codecs: z.string().optional(),
  width: z.number().optional(),
  height: z.number().optional(),
  bandwidth: z.number().optional(),
  mimeType: z.string().optional(),
  url: z.string().min(1),
  backupUrls: z.array(z.string()).default([]),
})
export type StreamSummary = z.infer<typeof streamSummarySchema>

/** POST /api/parse 请求体 */
export const parseRequestSchema = z.object({
  input: z.string().min(1, '请输入视频链接或 BV 号'),
  page: z.number().int().positive().optional(),
})
export type ParseRequest = z.infer<typeof parseRequestSchema>

/** POST /api/parse 响应 */
export const parseResultSchema = z.object({
  input: z.string(),
  bvid: bvidSchema,
  avid: z.number().int(),
  cid: z.number().int(),
  page: z.number().int(),
  title: z.string(),
  ownerMid: z.number().int(),
  ownerName: z.string(),
  cover: z.string(),
  durationSec: z.number().int().nonnegative().default(0),
  pages: z.array(videoPageSchema),
  session: accountSessionSchema,
  qualities: z.array(qualityAvailabilitySchema),
  audioQualities: z.array(audioAvailabilitySchema),
})
export type ParseResult = z.infer<typeof parseResultSchema>

/** POST /api/playurl 请求体 */
export const playurlRequestSchema = z.object({
  bvid: bvidSchema,
  cid: z.number().int().positive(),
})
export type PlayurlRequest = z.infer<typeof playurlRequestSchema>

/** POST /api/playurl 响应 */
export const playurlResultSchema = z.object({
  bvid: bvidSchema,
  cid: z.number().int(),
  durationSec: z.number().int().nonnegative().default(0),
  session: accountSessionSchema,
  qualities: z.array(qualityAvailabilitySchema),
  audioQualities: z.array(audioAvailabilitySchema),
  video: z.array(streamSummarySchema),
  audio: z.array(streamSummarySchema),
  urlTtlSec: z.number().int(),
})
export type PlayurlResult = z.infer<typeof playurlResultSchema>
