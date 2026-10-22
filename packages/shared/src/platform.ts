import { z } from 'zod'
import { parseBiliInput, type BiliInput, type ParseInputResult } from './video.js'

export const platformSchema = z.enum(['bilibili', 'douyin', 'xiaohongshu', 'youtube', 'unknown'])
export type Platform = z.infer<typeof platformSchema>
export type ExtractorPlatform = Exclude<Platform, 'bilibili' | 'unknown'>

export const platformLabel: Readonly<Record<Platform, string>> = {
  bilibili: 'B站',
  douyin: '抖音',
  xiaohongshu: '小红书',
  youtube: 'YouTube',
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
  domains: z.array(z.string().min(1)),
  coverDomains: z.array(z.string().min(1)),
  coverReferer: z.string().url(),
  cookieSupport: z.enum(['supported', 'unsupported']),
  urlNormalization: z.object({
    path: z.string().min(1),
    queryParam: z.string().min(1),
    targetHost: z.string().min(1),
    targetPath: z.string().min(1),
    valuePattern: z.enum(['digits']),
  }).optional(),
})
export type PlatformCatalogItem = z.infer<typeof platformCatalogItemSchema>

export const platformCatalog = [
  { platform: 'bilibili', label: 'B站', parse: true, download: true, video: true, audio: true, image: false, requiresExtractor: false, domains: ['bilibili.com', 'b23.tv'], coverDomains: ['hdslb.com', 'bilibili.com'], coverReferer: 'https://www.bilibili.com/', cookieSupport: 'unsupported' },
  { platform: 'douyin', label: '抖音', parse: true, download: true, video: true, audio: true, image: false, requiresExtractor: true, domains: ['douyin.com', 'iesdouyin.com'], coverDomains: ['douyinpic.com', 'pstatp.com', 'byteimg.com', 'douyincdn.com'], coverReferer: 'https://www.douyin.com/', cookieSupport: 'supported', urlNormalization: { path: '/jingxuan', queryParam: 'modal_id', targetHost: 'www.douyin.com', targetPath: '/video/{value}', valuePattern: 'digits' } },
  { platform: 'xiaohongshu', label: '小红书', parse: true, download: true, video: true, audio: false, image: true, requiresExtractor: true, domains: ['xiaohongshu.com', 'xhslink.com'], coverDomains: ['xhscdn.com'], coverReferer: 'https://www.xiaohongshu.com/', cookieSupport: 'supported' },
  { platform: 'youtube', label: 'YouTube', parse: true, download: true, video: true, audio: true, image: false, requiresExtractor: true, domains: ['youtube.com', 'youtu.be', 'youtube-nocookie.com'], coverDomains: ['ytimg.com', 'ggpht.com'], coverReferer: 'https://www.youtube.com/', cookieSupport: 'unsupported' },
] as const satisfies readonly PlatformCatalogItem[]

function buildDomainIndex(selector: (item: PlatformCatalogItem) => readonly string[]): Map<string, PlatformCatalogItem> {
  const index = new Map<string, PlatformCatalogItem>()
  for (const item of platformCatalog) {
    if (!item.parse) continue
    for (const domain of selector(item)) index.set(domain.toLowerCase(), item)
  }
  return index
}

const parseablePlatformByDomain = buildDomainIndex((item) => item.domains)
const coverPlatformByDomain = buildDomainIndex((item) => item.coverDomains)
const platformByKey = new Map(platformCatalog.map((item) => [item.platform, item]))

export function platformDefinition(platform: Platform): PlatformCatalogItem | undefined {
  if (platform === 'unknown') return undefined
  return platformByKey.get(platform)
}

export function platformForHost(hostname: string): Platform | undefined {
  return platformFromDomainIndex(hostname, parseablePlatformByDomain)
}

export function platformForCoverHost(hostname: string): Platform | undefined {
  return platformFromDomainIndex(hostname, coverPlatformByDomain)
}

export function platformCoverReferer(hostname: string): string | undefined {
  const platform = platformForCoverHost(hostname)
  return platform === undefined ? undefined : platformDefinition(platform)?.coverReferer
}

function platformFromDomainIndex(hostname: string, index: ReadonlyMap<string, PlatformCatalogItem>): Platform | undefined {
  let host = hostname.trim().toLowerCase().replace(/\.$/, '')
  while (host !== '') {
    const definition = index.get(host)
    if (definition !== undefined) return definition.platform
    const separator = host.indexOf('.')
    if (separator < 0) break
    host = host.slice(separator + 1)
  }
  return undefined
}

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
  | { platform: ExtractorPlatform; raw: string; url: string }
  | { platform: 'unknown'; raw: string }

export type MediaInputResult = { ok: true; value: MediaInput } | { ok: false; reason: string }

interface UrlLike {
  hostname: string
  pathname: string
  searchParams: { get(name: string): string | null }
  toString(): string
}

const UrlCtor = (globalThis as unknown as { URL?: new (input: string) => UrlLike }).URL

function isHost(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`)
}

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

function normalizePlatformUrl(url: UrlLike, definition: PlatformCatalogItem): string {
  const rule = definition.urlNormalization
  if (rule === undefined || url.pathname !== rule.path) return url.toString()
  const value = url.searchParams.get(rule.queryParam)
  if (value === null || rule.valuePattern === 'digits' && !/^\d+$/.test(value)) return url.toString()
  return `https://${rule.targetHost}${rule.targetPath.replace('{value}', encodeURIComponent(value))}`
}

export function detectPlatform(raw: string): Platform {
  const parsed = parseMediaInput(raw)
  return parsed.ok ? parsed.value.platform : 'unknown'
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
    const detectedPlatform = platformForHost(host)
    const definition = detectedPlatform === undefined ? undefined : platformDefinition(detectedPlatform)
    if (definition !== undefined && definition.platform !== 'bilibili') {
      const normalizedUrl = normalizePlatformUrl(url, definition)
      return { ok: true, value: { platform: definition.platform, raw: normalizedUrl, url: normalizedUrl } }
    }
  }

  const supported = platformCatalog.filter((item) => item.parse).map((item) => item.label).join('、')
  return { ok: false, reason: `无法识别来源，支持${supported}链接` }
}
