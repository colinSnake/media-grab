import { buvidSpiSchema, type FingerprintOverview } from '@mediagrab/shared'
import { ApiError } from '../lib/errors.js'
import { type Logger, maskSecret, silentLogger } from '../lib/logger.js'
import type { DeviceRepository } from '../store/repositories.js'
import { BILI_HOME, type BiliHttp } from './http.js'
import { BiliTicketService, type TicketState } from './ticket.js'

/**
 * 设备指纹（RISK §3.1 / §3.2）。
 *
 * **免登下指纹是硬要求，不是可选项**：没有登录态时，风控只能靠设备与请求特征判断，
 * 指纹频繁变化会被当成异常设备。因此：
 * - `buvid3` / `buvid4` 首次启动取一次，**落盘固定**，之后每次请求都用同一组；
 * - `b_nut` 与指纹一起保存（来自 `www.bilibili.com` 的 Set-Cookie，取不到则用当前时间兜底）；
 * - `bili_ticket` 是设备级匿名票据，与指纹同表存放，拿不到不阻塞功能。
 */

export const FINGERPRINT_SPI_URL = 'https://api.bilibili.com/x/frontend/finger/spi'

export interface Fingerprint {
  buvid3: string
  buvid4: string
  bNut: number
}

export interface FingerprintInitResult {
  fingerprint: Fingerprint
  /** 指纹来源：库（重启后复用）还是本次新取 */
  source: 'store' | 'network'
  bNutSource: 'cookie' | 'fallback'
  ticket: TicketState
}

/** 从 Set-Cookie 数组里取某个 cookie 的值（含 `__Secure-` 等前缀的兼容由调用方处理） */
export function readSetCookie(setCookies: readonly string[], name: string): string | undefined {
  const prefix = `${name}=`
  for (const raw of setCookies) {
    const head = raw.split(';', 1)[0]?.trim() ?? ''
    if (head.startsWith(prefix)) return head.slice(prefix.length)
  }
  return undefined
}

export interface FingerprintServiceOptions {
  http: BiliHttp
  repo?: DeviceRepository
  logger?: Logger
  ticket?: BiliTicketService
}

export class FingerprintService {
  readonly #http: BiliHttp
  readonly #repo: DeviceRepository | undefined
  readonly #logger: Logger
  readonly #ticket: BiliTicketService
  #current: Fingerprint | undefined
  #source: 'store' | 'network' | 'none' = 'none'
  #updatedAt: number | null = null
  #bNutSource: 'cookie' | 'fallback' = 'fallback'

  constructor(options: FingerprintServiceOptions) {
    this.#http = options.http
    this.#repo = options.repo
    this.#logger = options.logger ?? silentLogger
    this.#ticket =
      options.ticket ??
      new BiliTicketService({ http: options.http, repo: options.repo, logger: options.logger })
  }

  /** 从库读入内存（启动时调用一次即可；读取是纯同步操作） */
  load(): Fingerprint | undefined {
    const stored = this.#repo?.get()
    if (!stored) return undefined
    this.#current = { buvid3: stored.buvid3, buvid4: stored.buvid4, bNut: stored.bNut }
    this.#source = 'store'
    this.#updatedAt = stored.updatedAt
    return this.#current
  }

  current(): Fingerprint | undefined {
    return this.#current
  }

  get ticketService(): BiliTicketService {
    return this.#ticket
  }

  /**
   * 确保指纹存在：内存 → 库 → 网络（`/x/frontend/finger/spi`）。
   * 取到后立即落盘，进程重启后不再重新申请（避免设备被判定为"换了机器"）。
   */
  async ensure(): Promise<Fingerprint> {
    if (this.#current) return this.#current

    const stored = this.load()
    if (stored) {
      this.#logger.info({ buvid3: maskSecret(stored.buvid3) }, '复用已落盘的设备指纹')
      return stored
    }

    const spi = await this.#http.json(buvidSpiSchema, FINGERPRINT_SPI_URL, {
      class: 'api',
      cookie: 'none',
      referer: BILI_HOME,
      acceptCodes: [0],
      label: 'fingerprint:spi',
    })
    const buvid3 = spi.envelope.data.b_3
    const buvid4 = spi.envelope.data.b_4
    if (!buvid3 || !buvid4) {
      throw new ApiError(
        'FINGERPRINT_FAILED',
        '设备指纹接口没有返回 buvid3/buvid4（接口可能已变更）',
        'fatal',
        502,
      )
    }

    const { bNut, bNutSource } = await this.#fetchBNut()
    const updatedAt = this.#http.clock.nowMs()
    this.#current = { buvid3, buvid4, bNut }
    this.#source = 'network'
    this.#updatedAt = updatedAt
    this.#bNutSource = bNutSource
    this.#repo?.save({ buvid3, buvid4, bNut, updatedAt })

    this.#logger.info(
      { buvid3: maskSecret(buvid3), buvid4: maskSecret(buvid4), bNut, bNutSource },
      '设备指纹已获取并落盘',
    )
    return this.#current
  }

  /**
   * 完整初始化：指纹 + 票据。
   * 票据失败只记录（增强项），不影响返回值里的指纹可用性。
   */
  async initialize(): Promise<FingerprintInitResult> {
    // 先判断本次是"复用落盘指纹"还是"新取"，ensure() 之后 source 已被改写。
    // 注意 repo.get() 是 `DeviceRecord | null`（不是 undefined），这里必须用 `!= null`。
    const alreadyKnown = this.#current !== undefined || this.#repo?.get() != null
    const fingerprint = await this.ensure()
    const ticket = await this.#ticket.ensure()
    return {
      fingerprint,
      source: alreadyKnown ? 'store' : 'network',
      bNutSource: this.#bNutSource,
      ticket,
    }
  }

  /**
   * 组装 Cookie 头：`buvid3` + `buvid4` + `b_nut`，票据未过期时附带 `bili_ticket`。
   * 尚未拿到指纹时返回空串（自举阶段的请求就是"裸请求"）。
   */
  cookieHeader(): string {
    const fp = this.#current
    if (!fp) return ''
    const parts = [`buvid3=${fp.buvid3}`, `buvid4=${fp.buvid4}`, `b_nut=${fp.bNut}`]
    const { ticket, expireAt } = this.#ticket.current()
    if (ticket !== null && expireAt !== null && expireAt > this.#http.clock.nowSec()) {
      parts.push(`bili_ticket=${ticket}`)
    }
    return parts.join('; ')
  }

  /** 健康检查用的摘要（脱敏） */
  overview(): FingerprintOverview {
    const fp = this.#current
    const ticket = this.#ticket.current()
    return {
      present: fp !== undefined,
      buvid3Prefix: fp ? maskSecret(fp.buvid3, 4).replace(/\*+$/, '') : '',
      buvid4Prefix: fp ? maskSecret(fp.buvid4, 4).replace(/\*+$/, '') : '',
      bNut: fp?.bNut ?? null,
      source: this.#source,
      updatedAt: this.#updatedAt,
      ticket: {
        available: ticket.ticket !== null && (ticket.expireAt ?? 0) > this.#http.clock.nowSec(),
        ticket: ticket.ticket === null ? null : `${ticket.ticket.slice(0, 6)}…`,
        expireAt: ticket.expireAt,
        refreshed: false,
      },
    }
  }

  /** `b_nut`：优先取 www 首页 Set-Cookie；取不到用当前时间（b_nut 语义即 cookie 创建时间） */
  async #fetchBNut(): Promise<{ bNut: number; bNutSource: 'cookie' | 'fallback' }> {
    try {
      const home = await this.#http.text(BILI_HOME, {
        class: 'other',
        cookie: 'none',
        semantics: 'document',
        acceptCodes: [0],
        referer: BILI_HOME,
        label: 'fingerprint:b_nut',
      })
      const raw = readSetCookie(home.setCookies, 'b_nut')
      const parsed = raw === undefined ? Number.NaN : Number.parseInt(raw, 10)
      if (Number.isFinite(parsed) && parsed > 0) return { bNut: parsed, bNutSource: 'cookie' }
    } catch (err) {
      this.#logger.warn({ err }, '获取 b_nut 失败，回退为当前时间戳')
    }
    return { bNut: this.#http.clock.nowSec(), bNutSource: 'fallback' }
  }
}
