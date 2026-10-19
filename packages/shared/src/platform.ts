import { z } from 'zod'
import { parseBiliInput, type BiliInput, type ParseInputResult } from './video.js'

export const platformSchema = z.enum(['bilibili', 'douyin', 'xiaohongshu', 'unknown'])
export type Platform = z.infer<typeof platformSchema>

export const platformLabel: Readonly<Record<Platform, string>> = {
  bilibili: 'B站',
  douyin: '抖音',
  xiaohongshu: '小红书',
  unknown: '未知平台',
}

export const platformCatalogItemSchema = z.object({
  platform: platformSchema,
  label: z.string(),
  parse: z.boolean(),
  download: z.boolean(),
  video: z.boolean(),
  audio: z.boolean(),
  image: z.boolean(),
  requiresExtractor: z.boolean(),
})
export type PlatformCatalogItem = z.infer<typeof platformCatalogItemSchema>

export const platformCatalog: readonly PlatformCatalogItem[] = [
  { platform: 'bilibili', label: 'B站', parse: true, download: true, video: true, audio: true, image: false, requiresExtractor: false },
  { platform: 'douyin', label: '抖音', parse: true, download: true, video: true, audio: true, image: false, requiresExtractor: true },
  { platform: 'xiaohongshu', label: '小红书', parse: true, download: true, video: true, audio: false, image: true, requiresExtractor: true },
]

export const platformStatusSchema = platformCatalogItemSchema.extend({
  ready: z.boolean(),
  reason: z.string().default(''),
})
export type PlatformStatus = z.infer<typeof platformStatusSchema>

export const platformStatusResponseSchema = z.object({
  platforms: z.array(platformStatusSchema),
  extractor: z.object({
    available: z.boolean(),
    path: z.string(),
    version: z.string(),
    error: z.string(),
  }),
})
export type PlatformStatusResponse = z.infer<typeof platformStatusResponseSchema>

export type MediaInput =
  | { platform: 'bilibili'; raw: string; value: BiliInput }
  | { platform: 'douyin'; raw: string; url: string }
  | { platform: 'xiaohongshu'; raw: string; url: string }
  | { platform: 'unknown'; raw: string }

export type MediaInputResult = { ok: true; value: MediaInput } | { ok: false; reason: string }

interface UrlLike {
  hostname: string
  toString(): string
}

const UrlCtor = (globalThis as unknown as { URL?: new (input: string) => UrlLike }).URL

function toUrl(raw: string): UrlLike | undefined {
  if (typeof UrlCtor !== 'function') return undefined
  try {
    return new UrlCtor(raw)
  } catch {
    try {
      return new UrlCtor(`https://${raw}`)
    } catch {
      return undefined
    }
  }
}

/** 平台分享文案通常会夹带“复制打开……”和标点，先抽取其中的真实 URL。 */
function embeddedUrl(raw: string): string {
  const match = raw.match(/https?:\/\/[^\s<>"']+/i)
  if (match?.[0] === undefined) return raw
  // 兼容复制的 Markdown 链接：[标题](https://...)，以及其中的 `\&` 转义。
  return match[0].replace(/[),.;!?，。！？]+$/g, '').replace(/\\(?=[&#?])/g, '')
}

function isHost(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`)
}

export function detectPlatform(raw: string): Platform {
  const candidate = embeddedUrl(raw)
  const bili = parseBiliInput(candidate)
  if (bili.ok) return 'bilibili'
  const url = toUrl(candidate.trim())
  if (url === undefined) return 'unknown'
  const host = url.hostname.toLowerCase()
  if (isHost(host, 'douyin.com') || isHost(host, 'iesdouyin.com')) return 'douyin'
  if (isHost(host, 'xiaohongshu.com') || isHost(host, 'xhslink.com')) return 'xiaohongshu'
  return 'unknown'
}

export function parseMediaInput(raw: string): MediaInputResult {
  const input = raw.trim()
  if (input === '') return { ok: false, reason: '请输入媒体链接或平台 ID' }

  const candidate = embeddedUrl(input)
  const bili: ParseInputResult = parseBiliInput(candidate)
  if (bili.ok) return { ok: true, value: { platform: 'bilibili', raw: candidate, value: bili.value } }

  const url = toUrl(candidate)
  if (url !== undefined) {
    const host = url.hostname.toLowerCase()
    if (isHost(host, 'douyin.com') || isHost(host, 'iesdouyin.com')) {
      return { ok: true, value: { platform: 'douyin', raw: candidate, url: url.toString() } }
    }
    if (isHost(host, 'xiaohongshu.com') || isHost(host, 'xhslink.com')) {
      return { ok: true, value: { platform: 'xiaohongshu', raw: candidate, url: url.toString() } }
    }
  }

  return { ok: false, reason: '无法识别来源，支持 B站、抖音和小红书链接' }
}
