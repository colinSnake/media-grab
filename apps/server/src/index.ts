import { appConfigSchema, defaultAppConfig } from '@mediagrab/shared'
import { buildApp } from './app.js'
import { isLoopbackHost } from './lib/local-access.js'
import { resolveWebDist } from './paths.js'
import { createServices, initializeBili } from './services.js'

const defaults = defaultAppConfig()

/** PORT 可覆盖无持久化设置的启动默认值；发行版桌面端始终固定 9070。 */
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

const desktopCore = process.env.MEDIAGRAB_DESKTOP_CORE === '1'
const coreToken = desktopCore ? process.env.MEDIAGRAB_CORE_TOKEN : undefined
// Never pass the desktop session secret to yt-dlp, FFmpeg, or user-configured
// executable paths launched by the core later in this process.
delete process.env.MEDIAGRAB_CORE_TOKEN
// M1：SQLite 落盘（settings / device / wbi_keys），配置与设备指纹跨重启保持
const services = createServices({ config: bootstrapConfig })
if (desktopCore && !/^[a-f0-9]{64}$/.test(coreToken ?? '')) {
  throw new Error('桌面核心缺少有效的每次启动访问凭据')
}
// Packaged WebView uses a fixed endpoint; normalize legacy persisted settings so
// both the config API and the actual listener agree after a desktop restart.
if (desktopCore && (services.config.get().serverPort !== 9070 || services.config.get().bindHost !== '127.0.0.1')) {
  services.config.patch({ serverPort: 9070, bindHost: '127.0.0.1' })
}
const config = services.config.get()
if (!isLoopbackHost(config.bindHost)) {
  throw new Error('拒绝在非回环地址启动本地核心')
}
const webDist = resolveWebDist()
const app = await buildApp({ config, webDist, services, desktopCore, coreToken })
// 容器由本模块持有，退出时关闭数据库
app.addHook('onClose', async () => {
  services.close()
})

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
