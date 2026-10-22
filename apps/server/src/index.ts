import { appConfigSchema, defaultAppConfig } from '@mediagrab/shared'
import { buildApp } from './app.js'
import { resolveWebDist } from './paths.js'
import { createServices, initializeBili } from './services.js'

const defaults = defaultAppConfig()

/** PORT 环境变量优先（便于同机多实例与自动化验证）；库中已落盘的设置优先级更高 */
function envPort(fallback: number): number {
  const raw = process.env.PORT
  if (raw === undefined || raw.trim() === '') return fallback
  const parsed = Number(raw)
  return Number.isInteger(parsed) ? parsed : fallback
}

const envBindHost = process.env.HOST
const bootstrapConfig = appConfigSchema.parse({
  ...defaults,
  serverPort: envPort(defaults.serverPort),
  bindHost: envBindHost !== undefined && envBindHost.trim() !== '' ? envBindHost : defaults.bindHost,
})

// M1：SQLite 落盘（settings / device / wbi_keys），配置与设备指纹跨重启保持
const services = createServices({ config: bootstrapConfig })
const config = services.config.get()
const webDist = resolveWebDist()
const app = await buildApp({ config, webDist, services })
// 容器由本模块持有，退出时关闭数据库
app.addHook('onClose', async () => {
  services.close()
})

const LOOPBACK = ['127.0.0.1', 'localhost', '::1']
if (!LOOPBACK.includes(config.bindHost)) {
  app.log.warn(
    `bindHost=${config.bindHost} 不是本机回环地址。本服务可能持有账号凭据，请勿暴露到局域网或公网。`,
  )
}

app.log.info(
  {
    webDist,
    dbPath: services.dbPath,
    url: `http://${config.bindHost}:${config.serverPort}`,
    node: process.version,
  },
  'mediaGrab server',
)

let shuttingDown = false
const shutdown = async (signal: string): Promise<void> => {
  if (shuttingDown) return
  shuttingDown = true
  app.log.info({ signal }, '收到退出信号，正在关闭（会关闭 SQLite）')
  try {
    await app.close()
  } catch (err) {
    app.log.error({ err }, '关闭时出错')
  }
  process.exit(0)
}
process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))

try {
  await app.listen({ port: config.serverPort, host: config.bindHost })
  const init = await initializeBili(services, app.log)
  if (!init.ok) {
    app.log.warn(
      { error: init.error },
      '设备指纹尚未就绪：解析请求会在首次调用时重试；离线环境下不影响页面与 /api/health',
    )
  }
} catch (err) {
  app.log.error({ err }, '启动失败：端口可能已被占用，可用 PORT=<端口> 覆盖')
  process.exitCode = 1
  await app.close()
}
