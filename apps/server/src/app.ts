import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import fastifyStatic from '@fastify/static'
import Fastify, { type FastifyInstance } from 'fastify'
import type { AppConfig } from '@mediagrab/shared'
import { httpStatusOf, toApiErrorBody } from './lib/errors.js'
import { resolveWebDist } from './paths.js'
import { biliRoutes } from './routes/bili.js'
import { configRoutes } from './routes/config.js'
import { healthRoutes } from './routes/health.js'
import { sessionRoutes } from './routes/session.js'
import { taskRoutes } from './routes/tasks.js'
import { mediaRoutes } from './routes/media.js'
import fastifyWebsocket from '@fastify/websocket'
import { platformRoutes } from './routes/platforms.js'
import { createServices, type Services } from './services.js'

export interface BuildAppOptions {
  config: AppConfig
  /** 覆盖前端产物目录；默认自动定位 apps/web/dist（见 paths.ts） */
  webDist?: string
  /** 传 false 关闭请求日志（测试用） */
  logger?: boolean
  /**
   * 注入服务容器（测试用：内存库 + 假 fetch）。
   * 不传则自建 —— 会打开 SQLite（路径见 paths.ts）。
   */
  services?: Services
  /** 覆盖 SQLite 路径（仅自建服务时生效） */
  dbPath?: string
}

const NOT_BUILT_HINT =
  '前端尚未构建：先执行 `pnpm build`；开发时用 `pnpm dev:web`（Vite :9067）配合 `pnpm dev:server`。'

export async function buildApp(options: BuildAppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: options.logger === false ? false : { level: process.env.LOG_LEVEL ?? 'info' },
  })

  // 统一错误信封必须**在任何插件注册之前**设置：之后注册的路由上下文才会继承它。
  // 若在插件之后设置，路由里抛出的 ApiError 会落到 Fastify 默认错误处理器，
  // 表现为 500 + Fastify 自己的响应结构（本项目实测踩到过）。
  app.setErrorHandler((err, req, reply) => {
    const status = httpStatusOf(err)
    if (status >= 500) req.log.error({ err }, '请求处理失败')
    return reply.status(status).type('application/json').send(toApiErrorBody(err))
  })

  const ownsServices = options.services === undefined
  const services =
    options.services ??
    createServices({
      config: options.config,
      dbPath: options.dbPath,
      logger: app.log,
    })

  const webDist = options.webDist ?? resolveWebDist()
  const startedAt = Date.now()

  // 自建的服务由 app 负责关闭；外部注入的由调用方管理（测试里自己 close）
  if (ownsServices) {
    app.addHook('onClose', async () => {
      services.close()
    })
  }

  await app.register(healthRoutes, { store: services.config, services, webDist, startedAt })
  await app.register(fastifyWebsocket)
  await app.register(configRoutes, { store: services.config })
  await app.register(biliRoutes, { services })
  await app.register(sessionRoutes, { services })
  await app.register(taskRoutes, { services })
  await app.register(mediaRoutes, { services })
  await app.register(platformRoutes, { services })

  app.get('/api/ws', { websocket: true }, (socket) => {
    socket.send(JSON.stringify({ type: 'hello', serverTime: Date.now() }))
    const unsubscribe = services.downloads.subscribe((event) => {
      if (socket.readyState === 1) socket.send(JSON.stringify(event))
    })
    socket.on('close', unsubscribe)
    socket.on('error', unsubscribe)
  })

  const indexHtmlPath = path.join(webDist, 'index.html')
  const built = existsSync(indexHtmlPath)

  if (built) {
    // 前端产物在启动时读一次即可（M0 足够；改前端需重新构建并重启）
    const indexHtml = readFileSync(indexHtmlPath)

    await app.register(fastifyStatic, { root: webDist })

    // SPA fallback：静态资源未命中时交回 index.html 由前端路由处理
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/')) {
        return reply.status(404).type('application/json').send({
          error: {
            code: 'NOT_FOUND',
            message: `接口不存在: ${req.url}`,
            kind: 'notFound',
            retryable: false,
          },
        })
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        return reply.status(405).type('application/json').send({
          error: {
            code: 'METHOD_NOT_ALLOWED',
            message: `${req.method} 不被支持`,
            kind: 'invalid',
            retryable: false,
          },
        })
      }
      return reply.type('text/html; charset=utf-8').send(indexHtml)
    })
  } else {
    // 未构建时给出可操作的提示，而不是一个空白 404
    app.setNotFoundHandler((req, reply) => {
      if (req.url === '/' || req.url === '/index.html') {
        return reply
          .status(200)
          .type('text/html; charset=utf-8')
          .send(
            [
              '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">',
              '<title>mediaGrab</title></head>',
              '<body style="font:15px/1.8 -apple-system,BlinkMacSystemFont,\'Segoe UI\',sans-serif;',
              'max-width:46rem;margin:10vh auto;padding:0 1.5rem">',
              '<h1>后端已启动</h1>',
              `<p>${NOT_BUILT_HINT}</p>`,
              `<p>已定位的前端目录：<code>${webDist}</code>（其中没有 index.html）</p>`,
              '<p>健康检查：<a href="/api/health">/api/health</a></p>',
              '</body></html>',
            ].join(''),
          )
      }
      return reply.status(404).type('application/json').send({
        error: {
          code: 'NOT_FOUND',
          message: `路径不存在: ${req.url}。${NOT_BUILT_HINT}`,
          kind: 'notFound',
          retryable: false,
        },
      })
    })
  }

  return app
}
