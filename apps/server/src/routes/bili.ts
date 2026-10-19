import { parseRequestSchema, playurlRequestSchema } from '@mediagrab/shared'
import type { FastifyPluginAsync } from 'fastify'
import { parseBody } from '../lib/validate.js'
import type { Services } from '../services.js'

/**
 * 解析与取流路由（FR-01/02/03）。
 *
 * 两条路径都**不依赖任何凭据**：零凭据环境下必须可用（ADR-1）。
 * 失败一律走统一错误信封（分类 + 中文原因），不做静默降级。
 */
export interface BiliRoutesDeps {
  services: Services
}

export const biliRoutes: FastifyPluginAsync<BiliRoutesDeps> = async (app, opts) => {
  /** 链接解析：视频信息 + 分P + 各档位可用性 */
  app.post('/api/parse', async (req) => {
    const body = parseBody(parseRequestSchema, req.body)
    return opts.services.platforms.parse(body.input, body.page)
  })

  /** 取流：候选流 + 可用性 + 编码信息（M2 的下载引擎复用同一份结果） */
  app.post('/api/playurl', async (req) => {
    const body = parseBody(playurlRequestSchema, req.body)
    return opts.services.bili.playurl(body.bvid, body.cid)
  })
}
