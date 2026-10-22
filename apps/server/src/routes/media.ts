import { mediaParseRequestSchema, platformCoverReferer, platformForCoverHost } from '@mediagrab/shared'
import type { FastifyPluginAsync } from 'fastify'
import { ApiError } from '../lib/errors.js'
import { parseBody } from '../lib/validate.js'
import type { Services } from '../services.js'

export interface MediaRoutesDeps { services: Services }

const MAX_COVER_BYTES = 8 * 1024 * 1024

export function isAllowedCoverHost(hostname: string): boolean {
  return platformForCoverHost(hostname) !== undefined
}

function coverUrlFromQuery(value: unknown): URL {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ApiError('INVALID_COVER_URL', '封面地址不能为空', 'invalid', 400)
  }
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new ApiError('INVALID_COVER_URL', '封面地址格式不正确', 'invalid', 400)
  }
  if (url.protocol !== 'https:' || !isAllowedCoverHost(url.hostname)) {
    throw new ApiError('INVALID_COVER_URL', '封面地址来源不受支持', 'invalid', 400)
  }
  return url
}

async function readCoverBody(response: Response): Promise<Buffer> {
  const declaredLength = Number(response.headers.get('content-length') ?? 0)
  if (declaredLength > MAX_COVER_BYTES) throw new ApiError('COVER_TOO_LARGE', '封面文件过大', 'invalid', 413)
  if (response.body === null) throw new ApiError('INVALID_COVER_RESPONSE', '封面服务未返回内容', 'fatal', 502)

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      total += next.value.byteLength
      if (total > MAX_COVER_BYTES) {
        await reader.cancel()
        throw new ApiError('COVER_TOO_LARGE', '封面文件过大', 'invalid', 413)
      }
      chunks.push(next.value)
    }
  } finally {
    reader.releaseLock()
  }
  return Buffer.concat(chunks, total)
}

export const mediaRoutes: FastifyPluginAsync<MediaRoutesDeps> = async (app, opts) => {
  app.post('/api/media/parse', async (req) => {
    const body = parseBody(mediaParseRequestSchema, req.body)
    return opts.services.media.parse(body.input)
  })

/** 平台封面 CDN 在部分浏览器/WebView 中会被拦截，改由本地核心代取并缓存。 */
  app.get('/api/cover', async (req, reply) => {
    const query = req.query as { url?: unknown }
    const url = coverUrlFromQuery(query.url)
    let response: Response
    try {
      response = await fetch(url, {
        headers: {
          Accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
          Referer: platformCoverReferer(url.hostname) ?? 'https://www.bilibili.com/',
        },
        signal: AbortSignal.timeout(15_000),
      })
    } catch {
      throw new ApiError('COVER_FETCH_FAILED', '封面获取失败', 'network', 502)
    }
    if (!response.ok) {
      throw new ApiError('COVER_FETCH_FAILED', `封面获取失败（HTTP ${response.status}）`, 'network', 502)
    }
    const rawContentType = response.headers.get('content-type') ?? 'image/jpeg'
    const contentType = rawContentType.split(';', 1)[0]?.trim().toLowerCase() || 'image/jpeg'
    if (!contentType.startsWith('image/')) {
      throw new ApiError('INVALID_COVER_RESPONSE', '封面服务返回的不是图片', 'fatal', 502)
    }
    return reply
      .header('Cache-Control', 'public, max-age=86400')
      .type(contentType)
      .send(await readCoverBody(response))
  })

  app.get('/api/extractor/check', async () => opts.services.media.extractorStatus())
}
