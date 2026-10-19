import { existsSync } from 'node:fs'
import path from 'node:path'
import type { FastifyPluginAsync } from 'fastify'
import type { HealthResponse } from '@mediagrab/shared'
import type { ConfigStore } from '../lib/config-store.js'
import { maskSecret } from '../lib/logger.js'
import type { Services } from '../services.js'

const SERVER_VERSION = '0.1.0'

export interface HealthDeps {
  store: ConfigStore
  services: Services
  webDist: string
  startedAt: number
}

function localDay(atMs: number): string {
  return new Date(atMs).toDateString()
}

export const healthRoutes: FastifyPluginAsync<HealthDeps> = async (app, opts) => {
  // 返回类型与 shared 的 healthResponseSchema 绑定：字段漂移会在编译期暴露
  app.get('/api/health', async (): Promise<HealthResponse> => {
    const config = opts.store.get()
    const { services } = opts
    const indexHtml = path.join(opts.webDist, 'index.html')

    // 报告**实际监听**的地址，而不是配置值 —— 两者可能因 PATCH /api/config 后未重启而不同
    const address = app.server.address()
    const bound =
      typeof address === 'object' && address !== null
        ? { host: address.address, port: address.port }
        : { host: config.bindHost, port: config.serverPort }

    const wbiKeys = services.wbi.peek()
    const device = services.fingerprint.overview()

    // 数据库可用性：跑一次最轻量的读，失败也如实反映而不是假装健康
    let dbOk = true
    try {
      services.settings.get('__health__')
    } catch {
      dbOk = false
    }

    return {
      ok: true,
      name: 'mediaGrab',
      version: SERVER_VERSION,
      startedAt: new Date(opts.startedAt).toISOString(),
      uptimeSec: Math.round((Date.now() - opts.startedAt) / 1000),
      runtime: { node: process.version, platform: process.platform, pid: process.pid },
      // 免登优先：M1 登录态恒为匿名，这里如实返回，而不是假装支持（FR-14 是 M4 的可选增强）
      session: { loggedIn: false, vip: false, anonymous: true },
      web: { dist: opts.webDist, built: existsSync(indexHtml) },
      listen: bound,
      config: {
        savePath: config.savePath,
        defaultDownloadMode: config.defaultDownloadMode,
        audioContainer: config.audioContainer,
        serverPort: config.serverPort,
        /** 配置里的端口与实际监听不一致时为 true（需要重启才生效） */
        serverPortPendingRestart: bound.port !== config.serverPort,
      },
      bili: {
        db: { path: services.dbPath, ok: dbOk },
        device,
        wbi: wbiKeys
          ? {
              imgKey: maskSecret(wbiKeys.imgKey, 4),
              subKey: maskSecret(wbiKeys.subKey, 4),
              fetchedAt: wbiKeys.fetchedAt,
              /** false 表示 key 是往天的，下次请求会重取（自然日轮换） */
              sameDay: localDay(wbiKeys.fetchedAt) === localDay(services.clock.nowMs()),
            }
          : null,
        clock: {
          offsetMs: services.clock.offsetMs,
          serverNow: new Date(services.clock.nowMs()).toISOString(),
        },
        rateLimit: services.limiter.stats(),
      },
    }
  })
}
