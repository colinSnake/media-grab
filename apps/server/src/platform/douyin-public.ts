import { platformForCoverHost, type MediaParseResult, type MediaStream } from '@mediagrab/shared'
import { ApiError } from '../lib/errors.js'

const MOBILE_PAGE_USER_AGENT = 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1'
const MAX_PAGE_BYTES = 2 * 1024 * 1024

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function requestSignal(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(12_000)
  return signal === undefined ? timeout : AbortSignal.any([signal, timeout])
}

function videoUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && (url.hostname === 'douyinvod.com' || url.hostname.endsWith('.douyinvod.com')) ? url.href : undefined
  } catch {
    return undefined
  }
}

function videoId(url: URL): string | undefined {
  if (url.protocol !== 'https:' || !['www.douyin.com', 'douyin.com', 'www.iesdouyin.com', 'iesdouyin.com'].includes(url.hostname)) return undefined
  return /^\/(?:share\/)?video\/(\d+)\/?$/.exec(url.pathname)?.[1]
}

async function resolveVideoId(input: string, fetchImpl: typeof fetch, signal?: AbortSignal): Promise<string | undefined> {
  let url: URL
  try { url = new URL(input) } catch { return undefined }
  if (url.protocol !== 'https:') return undefined
  const direct = videoId(url)
  if (direct !== undefined) return direct
  if (url.hostname !== 'v.douyin.com' || !/^\/[\w-]+\/?$/.test(url.pathname)) return undefined
  const response = await fetchImpl(url, { redirect: 'manual', signal: requestSignal(signal) })
  await response.body?.cancel()
  if (response.status < 300 || response.status >= 400) return undefined
  try { return videoId(new URL(response.headers.get('location') ?? '', url)) } catch { return undefined }
}

async function readPage(response: Response): Promise<string | undefined> {
  if (!response.ok) {
    await response.body?.cancel()
    if (response.status === 429 || response.status === 412) throw new ApiError('PLATFORM_RATE_LIMITED', '抖音公开页请求受限，请稍后再试', 'risk', 429)
    if (response.status === 403) throw new ApiError('DOUYIN_PUBLIC_RESTRICTED', '抖音公开页拒绝访问该作品，请确认它在浏览器中可播放', 'permission', 403)
    if (response.status >= 500) throw new ApiError('DOUYIN_PUBLIC_FETCH_FAILED', '抖音公开页暂时无法访问，请稍后重试', 'network', 502)
    return undefined
  }
  if (response.body === null) return undefined
  if (Number(response.headers.get('content-length') ?? 0) > MAX_PAGE_BYTES) {
    await response.body.cancel()
    return undefined
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const item = await reader.read()
      if (item.done) break
      total += item.value.byteLength
      if (total > MAX_PAGE_BYTES) {
        await reader.cancel()
        return undefined
      }
      chunks.push(item.value)
    }
  } finally {
    reader.releaseLock()
  }
  return Buffer.concat(chunks, total).toString('utf8')
}

/** Public Jingxuan pages may have media data when Douyin's detail API returns 403. */
export async function parsePublicDouyinVideo(input: string, fetchImpl: typeof fetch = fetch, signal?: AbortSignal): Promise<MediaParseResult | undefined> {
  const id = await resolveVideoId(input, fetchImpl, signal)
  if (id === undefined) return undefined
  const response = await fetchImpl(`https://jingxuan.douyin.com/m/video/${id}`, {
    headers: { 'User-Agent': MOBILE_PAGE_USER_AGENT },
    redirect: 'manual',
    signal: requestSignal(signal),
  })
  const html = await readPage(response)
  const raw = /<script\b[^>]*>\s*window\._SSR_DATA\s*=\s*([\s\S]*?)<\/script>/i.exec(html ?? '')?.[1]?.trim().replace(/;$/, '')
  if (raw === undefined) return undefined
  let result: Record<string, unknown> | undefined
  let model: Record<string, unknown> | undefined
  try {
    const root = record(JSON.parse(raw))
    result = record(record(record(record(record(root?.data)?.storeState)?.detail)?.videoData)?.result)
    if (typeof result?.video_model !== 'string') return undefined
    model = record(JSON.parse(result.video_model))
  } catch { return undefined }
  if (String(result?.gid) !== id || model === undefined || !Array.isArray(model.video_list)) return undefined
  if (typeof model.url_expire === 'number' && model.url_expire <= Date.now() / 1000) return undefined

  const streams: MediaStream[] = []
  const seen = new Set<string>()
  for (const candidate of model.video_list) {
    const item = record(candidate)
    const meta = record(item?.video_meta)
    const url = videoUrl(item?.main_url) ?? videoUrl(item?.backup_url)
    if (url === undefined || meta === undefined || typeof meta.file_id !== 'string' || meta.file_id === '' || seen.has(meta.file_id)) continue
    seen.add(meta.file_id)
    const backup = videoUrl(item?.backup_url)
    const width = typeof meta.vwidth === 'number' && meta.vwidth > 0 ? meta.vwidth : undefined
    const height = typeof meta.vheight === 'number' && meta.vheight > 0 ? meta.vheight : undefined
    const fps = typeof meta.fps === 'number' && meta.fps > 0 ? meta.fps : undefined
    const size = typeof meta.size === 'number' && Number.isSafeInteger(meta.size) && meta.size > 0 ? meta.size : undefined
    const bitrate = typeof meta.bitrate === 'number' && Number.isSafeInteger(meta.bitrate) && meta.bitrate >= 0 ? meta.bitrate : undefined
    const definition = typeof meta.definition === 'string' && /^\d{3,4}p$/i.test(meta.definition) ? meta.definition.toUpperCase() : height ? `${height}P` : '视频'
    const hasAudio = meta.audio_channels !== undefined
      ? Number(meta.audio_channels) > 0
      : typeof meta.audio_bitrate_target === 'number' && meta.audio_bitrate_target > 0
    streams.push({
      id: `douyin-public:${meta.file_id}`,
      kind: 'video', combined: hasAudio,
      label: `${definition}${fps ? ` ${fps}fps` : ''}`,
      url, backupUrls: backup && backup !== url ? [backup] : [],
      width, height, bitrate, sizeBytes: size,
      codecs: typeof meta.codec_type === 'string' ? meta.codec_type : undefined,
      mimeType: 'video/mp4',
      httpHeaders: { Referer: 'https://jingxuan.douyin.com/' },
      available: true, reason: '',
    })
  }
  if (streams.length === 0) return undefined
  streams.sort((left, right) => (right.height ?? 0) - (left.height ?? 0) || (right.bitrate ?? 0) - (left.bitrate ?? 0))
  const user = record(result.media_user)
  let cover = ''
  if (typeof result.cover_image_url === 'string') {
    try {
      const url = new URL(result.cover_image_url)
      if (url.protocol === 'https:' && platformForCoverHost(url.hostname) === 'douyin') cover = url.href
    } catch { /* No usable cover. */ }
  }
  return {
    platform: 'douyin', input: `https://www.douyin.com/video/${id}`, id,
    title: typeof result.title === 'string' ? result.title : '',
    authorName: typeof user?.screen_name === 'string' ? user.screen_name : '',
    cover,
    durationSec: typeof model.video_duration === 'number' ? Math.max(0, Math.round(model.video_duration)) : 0,
    streams, itemCount: 1,
    capabilities: { video: true, audio: streams.some((stream) => stream.combined), image: false, download: true },
  }
}
