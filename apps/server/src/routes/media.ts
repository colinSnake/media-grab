import { mediaParseRequestSchema } from '@mediagrab/shared'
import type { FastifyPluginAsync } from 'fastify'
import { ApiError } from '../lib/errors.js'
import { parseBody } from '../lib/validate.js'
import type { Services } from '../services.js'

export interface MediaRoutesDeps { services: Services }

function isAllowedCoverHost(hostname: string): boolean {
  const host = hostname.toLowerCase()
  return host.endsWith('.hdslb.com') || host === 'hdslb.com' || host.endsWith('.bilibili.com') || host === 'bilibili.com'
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
    throw new ApiError('INVALID_COVER_URL', '只允许代理 B站封面地址', 'invalid', 400)
  }
  return url
}

export const mediaRoutes: FastifyPluginAsync<MediaRoutesDeps> = async (app, opts) => {
  app.post('/api/media/parse', async (req) => {
    const body = parseBody(mediaParseRequestSchema, req.body)
    return opts.services.media.parse(body.input)
  })

  /** B站封面 CDN 在部分浏览器/WebView 中会被拦截，改由本地核心代取并缓存。 */
  app.get('/api/cover', async (req, reply) => {
    const query = req.query as { url?: unknown }
    const url = coverUrlFromQuery(query.url)
    let response: Response
    try {
      response = await fetch(url, {
        headers: {
          Accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
          Referer: 'https://www.bilibili.com/',
        },
        signal: AbortSignal.timeout(15_000),
      })
    } catch {
      throw new ApiError('COVER_FETCH_FAILED', '封面获取失败', 'network', 502)
    }
    if (!response.ok) {
      throw new ApiError('COVER_FETCH_FAILED', `封面获取失败（HTTP ${response.status}）`, 'network', 502)
    }
    const contentType = response.headers.get('content-type') ?? 'image/jpeg'
    if (!contentType.toLowerCase().startsWith('image/')) {
      throw new ApiError('INVALID_COVER_RESPONSE', '封面服务返回的不是图片', 'fatal', 502)
    }
    return reply
      .header('Cache-Control', 'public, max-age=86400')
      .type(contentType)
      .send(Buffer.from(await response.arrayBuffer()))
  })

  app.get('/api/extractor/check', async () => opts.services.media.extractorStatus())
}
