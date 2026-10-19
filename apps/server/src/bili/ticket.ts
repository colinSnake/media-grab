import { createHmac } from 'node:crypto'
import { z } from 'zod'
import type { Logger } from '../lib/logger.js'
import { silentLogger } from '../lib/logger.js'
import { redactTicket } from '../lib/logger.js'
import type { DeviceRepository } from '../store/repositories.js'
import type { BiliHttp } from './http.js'

/**
 * `bili_ticket`（设备级匿名票据）。
 *
 * 实测结论（M1-9，2026-10-16）：**免登可得**。
 * `POST /bapis/bilibili.api.ticket.v1.Ticket/GenWebTicket?key_id=ec02&hexsign=…&context[ts]=…&csrf=`
 * 在无 `SESSDATA`、csrf 为空串时返回 `code=0`，票据为 JWT，`ttl=259200`（3 天）。
 * 注意：RISK-CONTROL 旧稿里的 `…/bilibili-ticket/api/v1/ticket` 已废弃（返回 404）。
 *
 * 拿到票据不代表必须用：拿不到时只记录原因，绝不阻塞解析链路（RISK §3.3）。
 */

export const TICKET_HMAC_KEY = 'XgwSnGZ1p'
export const GEN_WEB_TICKET_URL =
  'https://api.bilibili.com/bapis/bilibili.api.ticket.v1.Ticket/GenWebTicket'
/** 接口未给 ttl 时的兜底有效期（秒） */
export const TICKET_TTL_FALLBACK_SEC = 259_200

/** `hexsign = HMAC-SHA256(key=XgwSnGZ1p, message="ts" + ts)` */
export function ticketHexSign(ts: number): string {
  return createHmac('sha256', TICKET_HMAC_KEY).update(`ts${ts}`).digest('hex')
}

export const ticketResponseSchema = z.object({
  code: z.number(),
  message: z.string().optional(),
  data: z
    .object({
      ticket: z.string(),
      created_at: z.number().optional(),
      ttl: z.number().optional(),
    })
    .optional(),
})

export interface TicketState {
  /** 手上是否有未过期票据 */
  available: boolean
  ticket: string | null
  expireAt: number | null
  /** 本次调用是否真的重新获取了 */
  refreshed: boolean
  reason?: string
}

export interface BiliTicketServiceOptions {
  http: BiliHttp
  repo?: DeviceRepository
  logger?: Logger
  /** 距过期不足该秒数时提前刷新，默认 6 小时 */
  refreshBeforeSec?: number
  /** 登录态下的 `bili_jct`（M4 才可能非空） */
  csrfProvider?: () => string | undefined
}

export class BiliTicketService {
  readonly #http: BiliHttp
  readonly #repo: DeviceRepository | undefined
  readonly #logger: Logger
  readonly #refreshBeforeSec: number
  readonly #csrfProvider: () => string | undefined

  constructor(options: BiliTicketServiceOptions) {
    this.#http = options.http
    this.#repo = options.repo
    this.#logger = options.logger ?? silentLogger
    this.#refreshBeforeSec = options.refreshBeforeSec ?? 6 * 60 * 60
    this.#csrfProvider = options.csrfProvider ?? (() => undefined)
  }

  /** 库里的票据（不发起请求） */
  current(): { ticket: string | null; expireAt: number | null } {
    const stored = this.#repo?.getTicket()
    return { ticket: stored?.ticket ?? null, expireAt: stored?.expireAt ?? null }
  }

  /**
   * 确保有可用票据。
   * **任何失败都只体现在返回值里，不抛异常** —— 票据是"降低风控概率"的增强项，
   * 不是链路的前置条件。
   */
  async ensure(force = false): Promise<TicketState> {
    const nowSec = this.#http.clock.nowSec()
    const { ticket: storedTicket, expireAt: storedExpireAt } = this.current()

    if (
      !force &&
      storedTicket !== null &&
      storedExpireAt !== null &&
      storedExpireAt - this.#refreshBeforeSec > nowSec
    ) {
      return { available: true, ticket: storedTicket, expireAt: storedExpireAt, refreshed: false }
    }

    const ts = this.#http.clock.nowSec()
    try {
      const response = await this.#http.json(ticketResponseSchema, GEN_WEB_TICKET_URL, {
        method: 'POST',
        class: 'api',
        cookie: 'auto',
        query: {
          key_id: 'ec02',
          hexsign: ticketHexSign(ts),
          'context[ts]': ts,
          csrf: this.#csrfProvider() ?? '',
        },
        referer: 'https://www.bilibili.com/',
        acceptCodes: [0],
        label: 'fingerprint:ticket',
      })

      const ticket = response.envelope.data?.ticket
      if (!ticket) {
        const reason = `票据接口未返回 ticket（code=${response.code}）`
        this.#logger.warn({ ts }, reason)
        return { available: false, ticket: null, expireAt: null, refreshed: false, reason }
      }

      const createdAt = response.envelope.data?.created_at ?? nowSec
      const ttl = response.envelope.data?.ttl ?? TICKET_TTL_FALLBACK_SEC
      const expireAt = createdAt + ttl
      this.#repo?.saveTicket(ticket, expireAt)
      this.#logger.info(
        { ticket: redactTicket(ticket), expireAt, ttl },
        'bili_ticket 已获取（免登）',
      )
      return { available: true, ticket, expireAt, refreshed: true }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      this.#logger.warn({ err: reason }, 'bili_ticket 获取失败（不影响免登解析）')
      return {
        available: storedTicket !== null,
        ticket: storedTicket,
        expireAt: storedExpireAt,
        refreshed: false,
        reason,
      }
    }
  }
}
