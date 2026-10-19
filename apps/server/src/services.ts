import type { AppConfig } from '@mediagrab/shared'
import { BiliClient } from './bili/client.js'
import { FingerprintService } from './bili/fingerprint.js'
import { BiliHttp } from './bili/http.js'
import { BiliTicketService } from './bili/ticket.js'
import { WbiKeyService } from './bili/wbi.js'
import { Clock } from './lib/clock.js'
import { ConfigStore } from './lib/config-store.js'
import { type Logger, silentLogger } from './lib/logger.js'
import { BiliRateLimiter, type SleepFn } from './lib/token-bucket.js'
import { resolveDbPath } from './paths.js'
import { Database } from './store/db.js'
import { AccountRepository, DeviceRepository, SettingsRepository, TaskRepository, WbiKeyRepository } from './store/repositories.js'
import { MediaRegistry, PlatformRegistry } from './platform/registry.js'
import { TaskService } from './download/task-service.js'
import { AccountService } from './accounts/account-service.js'
import { CredentialVault } from './accounts/credential-vault.js'

/**
 * 服务装配（依赖注入的唯一入口）。
 *
 * 把"谁依赖谁"集中在一处，路由只拿 `Services`，测试可以整体换成内存库 + 假 fetch ——
 * 这是"核心逻辑不依赖真实网络"（G6）能落地的前提。
 */

export interface CreateServicesOptions {
  /** 默认配置（已合并环境变量）；库中已落盘的设置优先 */
  config: AppConfig
  /** 覆盖 SQLite 路径；`:memory:` 用于测试 */
  dbPath?: string
  logger?: Logger
  /** 测试注入：替换 global fetch */
  fetchImpl?: typeof fetch
  /** 测试注入：替换 sleep（避免退避真的等 30 秒） */
  sleep?: SleepFn
  /** 测试注入：替换限速器 */
  limiter?: BiliRateLimiter
  /** 测试注入：本机时间源 */
  now?: () => number
}

export interface Services {
  dbPath: string
  db: Database
  settings: SettingsRepository
  device: DeviceRepository
  wbiKeys: WbiKeyRepository
  tasks: TaskRepository
  accounts: AccountRepository
  config: ConfigStore
  clock: Clock
  limiter: BiliRateLimiter
  http: BiliHttp
  fingerprint: FingerprintService
  ticket: BiliTicketService
  wbi: WbiKeyService
  bili: BiliClient
  platforms: PlatformRegistry
  media: MediaRegistry
  downloads: TaskService
  accountService: AccountService
  /** 关闭数据库；由 app 的 onClose 钩子调用 */
  close: () => void
}

export function createServices(options: CreateServicesOptions): Services {
  const logger = options.logger ?? silentLogger
  const dbPath = options.dbPath ?? resolveDbPath()
  const db = Database.open(dbPath)

  const settings = new SettingsRepository(db)
  const device = new DeviceRepository(db)
  const wbiKeys = new WbiKeyRepository(db)
  const tasks = new TaskRepository(db)
  const accounts = new AccountRepository(db)

  // 库里的设置覆盖启动默认值（NFR-10：配置立即生效，重启后仍在）
  const config = ConfigStore.load(settings, options.config)

  const clock = new Clock(options.now)
  const limiter =
    options.limiter ?? new BiliRateLimiter({ now: options.now, sleep: options.sleep })
  const http = new BiliHttp({
    clock,
    limiter,
    logger,
    fetchImpl: options.fetchImpl,
    sleep: options.sleep,
    localNow: options.now,
  })

  const ticket = new BiliTicketService({ http, repo: device, logger })
  const fingerprint = new FingerprintService({ http, repo: device, logger, ticket })
  // 重启后复用已落盘的指纹（免登下指纹必须稳定）
  fingerprint.load()
  const vault = dbPath === ':memory:' ? CredentialVault.inMemory() : new CredentialVault()
  const accountService = new AccountService({ repo: accounts, vault, http, deviceCookieProvider: () => fingerprint.cookieHeader(), logger })
  // 设备指纹与当前平台账号 Cookie 在本机核心合并，永远不回传 UI。
  http.setCookieProvider(() => [fingerprint.cookieHeader(), accountService.cookieHeader()].filter(Boolean).join('; '))

  const wbi = new WbiKeyService({ http, repo: wbiKeys, logger })
  wbi.peek() // 同步预热内存缓存（当天已取过就不再请求 nav）

  const bili = new BiliClient({ http, wbi, fingerprint, sessionProvider: () => accountService.session(), logger })
  const platforms = new PlatformRegistry(bili)
  const media = new MediaRegistry({ bili, config, logger })
  const downloads = new TaskService({
    repo: tasks,
    bili,
    platforms,
    media,
    config,
    logger,
    fetchImpl: options.fetchImpl ?? fetch,
  })

  return {
    dbPath,
    db,
    settings,
    device,
    wbiKeys,
    tasks,
    accounts,
    config,
    clock,
    limiter,
    http,
    fingerprint,
    ticket,
    wbi,
    bili,
    platforms,
    media,
    downloads,
    accountService,
    close: () => db.close(),
  }
}

export interface InitializeResult {
  ok: boolean
  fingerprintSource: 'store' | 'network' | 'none'
  ticketAvailable: boolean
  error?: string
}

/**
 * 启动初始化：设备指纹（必需）+ `bili_ticket`（增强）。
 *
 * **失败不抛异常**：本机无网时服务照样要能起来（页面与 /api/health 仍可用），
 * 真正的 B站请求会在 /api/parse 时重试并给出明确错误。
 */
export async function initializeBili(
  services: Services,
  logger: Logger = silentLogger,
): Promise<InitializeResult> {
  try {
    const result = await services.bili.initialize()
    logger.info(
      {
        fingerprintSource: result.source,
        bNutSource: result.bNutSource,
        ticket: result.ticket.available,
        ticketRefreshed: result.ticket.refreshed,
      },
      '免登初始化完成（指纹 + bili_ticket）',
    )
    return {
      ok: true,
      fingerprintSource: result.source,
      ticketAvailable: result.ticket.available,
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    logger.warn({ err: message }, '免登初始化失败（服务仍可启动，解析时会重试）')
    return { ok: false, fingerprintSource: 'none', ticketAvailable: false, error: message }
  }
}
