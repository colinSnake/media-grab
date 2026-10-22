import { BILI_CODE } from '@mediagrab/shared'
import { z, type ZodTypeAny } from 'zod'
import { Clock } from '../lib/clock.js'
import { ApiError, apiErrorFromBiliCode, apiErrorFromHttpStatus } from '../lib/errors.js'
import {
  type Logger,
  redactCookie,
  redactUrl,
  silentLogger,
} from '../lib/logger.js'
import { INTERACTIVE_RETRY, withRetry, type RetryPolicy } from '../lib/retry.js'
import {
  BiliRateLimiter,
  defaultSleep,
  type RateLimitClass,
  type SleepFn,
} from '../lib/token-bucket.js'

/**
 * 唯一的出网入口（NFR-03/04/07）。
 *
 * 所有对 B站的请求都必须从这里走，原因不是"代码整洁"，而是三条硬约束只有在这里
 * 才能同时成立：
 * 1. **限速**（令牌桶 + 并发上限）—— 绕过它就等于绕过风控保护；
 * 2. **错误分类先于重试** —— 分类逻辑散落各处必然出现"权限错误被重试三次"；
 * 3. **日志脱敏** —— Cookie 明文一旦进日志就再也收不回来。
 *
 * M2 的下载引擎取流后走 CDN，那是另一条路径（防盗链 + 链接过期），
 * 但不允许绕开本模块去调 api.bilibili.com。
 */

/**
 * 当前稳定 Chrome UA。
 *
 * RISK §3 要求「请求头自洽」：UA 与 `sec-ch-ua` 的版本号必须一致，**一致 > 随机**。
 * 升级时请同时改 UA_MAJOR 与 SEC_CH_UA_PLATFORM，`http.test.ts` 有断言兜底。
 */
export const UA_MAJOR = '131'
export const SEC_CH_UA_PLATFORM = 'macOS'
export const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  `Chrome/${UA_MAJOR}.0.0.0 Safari/537.36`
export const SEC_CH_UA = `"Chromium";v="${UA_MAJOR}", "Google Chrome";v="${UA_MAJOR}", "Not-A.Brand";v="99"`

export const BILI_HOME = 'https://www.bilibili.com/'

/** 取流地址 120 分钟后过期（RISK §3）；M2 的续传要用它判断是否需要重取 */
export const STREAM_URL_TTL_SEC = 120 * 60

/** 风控拦截页特征（HTML，非 JSON） */
const RISK_PAGE_MARKERS = ['出错啦', '风控', '请求过于频繁', '访问被拒绝', 'v_voucher', 'banned']

export function looksLikeRiskPage(body: string): boolean {
  const head = body.slice(0, 2_000)
  return RISK_PAGE_MARKERS.some((marker) => head.includes(marker))
}

export function biliVideoReferer(bvid: string): string {
  return `https://www.bilibili.com/video/${bvid}`
}

function originOf(url: string): string {
  try {
    return new URL(url).origin
  } catch {
    return ''
  }
}

/** 粗略判断"同一站点"（注册域相同）；B站各域名都属于 bilibili.com */
function isSameSite(originA: string, originB: string): boolean {
  if (originA === '' || originB === '') return false
  if (originA === originB) return true
  try {
    const domain = (host: string): string => host.split('.').slice(-2).join('.')
    return domain(new URL(originA).hostname) === domain(new URL(originB).hostname)
  } catch {
    return false
  }
}

/** 请求头语义：api 类（XHR）与 document 类（页面导航）不能混用同一套 Sec-Fetch-* */
export type FetchSemantics = 'api' | 'document'

export interface BiliRequestOptions {
  /** 限速类别；默认 `api` */
  class?: RateLimitClass
  method?: 'GET' | 'POST'
  query?: Record<string, string | number | boolean | undefined>
  headers?: Record<string, string>
  /** `none`：不带任何 Cookie（指纹自举、首页取 Set-Cookie） */
  cookie?: 'auto' | 'none'
  referer?: string
  /** POST 时是否带 Origin；不传则按 referer 推导（bilibili.com 域） */
  origin?: string | false
  /** 表单体（application/x-www-form-urlencoded） */
  form?: Record<string, string | number>
  /** 原始体（配合 contentType） */
  body?: string
  contentType?: string
  semantics?: FetchSemantics
  signal?: AbortSignal
  /** 允许的业务码；默认 [0]。`nav` 匿名返回 -101，需要显式放行 */
  acceptCodes?: readonly number[]
  /** 覆盖某个业务码的文案 */
  messageOverride?: Partial<Record<number, string>>
  timeoutMs?: number
  retryPolicy?: RetryPolicy
  /** 日志标签，便于定位是哪个调用方在打请求 */
  label?: string
  /** `manual` 用于读 b23.tv 的 Location，不跟随跳转 */
  redirect?: 'follow' | 'manual'
}

export interface BiliJsonResponse<T> {
  /** 已通过 zod 校验的完整响应信封 */
  envelope: T
  code: number
  message: string | undefined
  status: number
  /** 脱敏后的最终 URL（可安全进日志） */
  url: string
  setCookies: string[]
}

export interface BiliTextResponse {
  status: number
  text: string
  location: string | null
  setCookies: string[]
  url: string
}

export interface BiliHttpOptions {
  limiter?: BiliRateLimiter
  clock?: Clock
  logger?: Logger
  fetchImpl?: typeof fetch
  sleep?: SleepFn
  userAgent?: string
  defaultTimeoutMs?: number
  defaultRetryPolicy?: RetryPolicy
  /** 本机时间源（时钟校正用；测试注入） */
  localNow?: () => number
  /** 抖动随机源（测试注入以求确定性；默认 Math.random） */
  random?: () => number
}

interface ResolvedRequest {
  url: string
  displayUrl: string
  method: 'GET' | 'POST'
  headers: Record<string, string>
  body: string | undefined
  acceptCodes: readonly number[]
  messageOverride: Partial<Record<number, string>> | undefined
  signal: AbortSignal | undefined
  timeoutMs: number
  retryPolicy: RetryPolicy
  cls: RateLimitClass
  label: string
  redirect: 'follow' | 'manual'
  cookie: 'auto' | 'none'
}

export class BiliHttp {
  readonly clock: Clock
  readonly limiter: BiliRateLimiter

  readonly #fetch: typeof fetch
  readonly #logger: Logger
  readonly #sleep: SleepFn
  readonly #userAgent: string
  readonly #defaultTimeoutMs: number
  readonly #defaultRetryPolicy: RetryPolicy
  readonly #localNow: () => number
  readonly #random: () => number
  #cookieProvider: () => string | undefined = () => undefined

  constructor(options: BiliHttpOptions = {}) {
    this.clock = options.clock ?? new Clock(options.localNow)
    this.limiter = options.limiter ?? new BiliRateLimiter()
    this.#fetch = options.fetchImpl ?? globalThis.fetch
    this.#logger = options.logger ?? silentLogger
    this.#sleep = options.sleep ?? defaultSleep
    this.#userAgent = options.userAgent ?? DEFAULT_USER_AGENT
    this.#defaultTimeoutMs = options.defaultTimeoutMs ?? 15_000
    this.#defaultRetryPolicy = options.defaultRetryPolicy ?? INTERACTIVE_RETRY
    this.#localNow = options.localNow ?? Date.now
    this.#random = options.random ?? Math.random
  }

  /**
   * 注册 Cookie 来源（设备指纹 + 可选登录态）。
   * 用回调而不是值，是为了避免"启动时还没有指纹"的时序问题：
   * 指纹服务自举完成后，后续请求自动带上，无需重建 http 实例。
   */
  setCookieProvider(provider: () => string | undefined): void {
    this.#cookieProvider = provider
  }

  /** 当前会带上的 Cookie（已脱敏，可进日志） */
  describeCookie(): string {
    return redactCookie(this.#cookieProvider())
  }

  /**
   * 发起请求并解析为 B站 JSON 信封。
   *
   * 泛型用 `z.infer<S>`（**输出**类型）而不是 `ZodType<T>`：后者在 zod v3 下会推成输入类型，
   * schema 里 `.default()` 的字段会变成可选，调用方拿不到"字段一定有值"的保证。
   */
  async json<S extends ZodTypeAny>(
    schema: S,
    url: string,
    options: BiliRequestOptions = {},
  ): Promise<BiliJsonResponse<z.infer<S>>> {
    const resolved = this.#resolve(url, options)
    return this.#withRetry(resolved, async () => {
      const { response, requestStartMs, requestEndMs } = await this.#dispatch(resolved)
      const setCookies = response.headers.getSetCookie()
      const raw = await response.text()
      this.#observeClock(response, requestStartMs, requestEndMs)

      if (!response.ok) throw this.#httpError(response.status, raw, resolved)

      let parsed: unknown
      try {
        parsed = JSON.parse(raw)
      } catch {
        throw this.#bodyError(response.status, raw, resolved)
      }

      const result = schema.safeParse(parsed)
      if (!result.success) {
        const detail = result.error.issues
          .slice(0, 3)
          .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
          .join('; ')
        throw new ApiError(
          'UNEXPECTED_RESPONSE',
          `B站响应结构与预期不符：${detail}`,
          'fatal',
          502,
        )
      }

      const envelope = result.data as { code?: unknown; message?: unknown }
      if (typeof envelope.code !== 'number') {
        throw this.#bodyError(response.status, raw, resolved)
      }
      const code = envelope.code
      if (!resolved.acceptCodes.includes(code)) {
        const override = resolved.messageOverride?.[code]
        const message = override ?? (typeof envelope.message === 'string' ? envelope.message : undefined)
        throw apiErrorFromBiliCode(code, message)
      }

      return {
        envelope: result.data,
        code,
        message: typeof envelope.message === 'string' ? envelope.message : undefined,
        status: response.status,
        url: resolved.displayUrl,
        setCookies,
      }
    })
  }

  /** 取原始文本（首页 HTML、b23.tv 跳转头）；同样受限速与重试保护 */
  async text(url: string, options: BiliRequestOptions = {}): Promise<BiliTextResponse> {
    const resolved = this.#resolve(url, options)
    return this.#withRetry(resolved, async () => {
      const { response, requestStartMs, requestEndMs } = await this.#dispatch(resolved)
      const setCookies = response.headers.getSetCookie()
      const body = await response.text()
      this.#observeClock(response, requestStartMs, requestEndMs)

      if (!response.ok && response.status !== 302 && response.status !== 301) {
        throw this.#httpError(response.status, body, resolved)
      }
      return {
        status: response.status,
        text: body,
        location: response.headers.get('location'),
        setCookies,
        url: resolved.displayUrl,
      }
    })
  }

  /* ------------------------------- 内部实现 ------------------------------- */

  #resolve(url: string, options: BiliRequestOptions): ResolvedRequest {
    const target = new URL(url)
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value === undefined) continue
      target.searchParams.set(key, typeof value === 'boolean' ? (value ? '1' : '0') : String(value))
    }

    const method = options.method ?? 'GET'
    const semantics = options.semantics ?? 'api'
    const referer = options.referer ?? BILI_HOME
    const refererOrigin = originOf(referer)
    const crossOrigin = refererOrigin !== target.origin
    const headers: Record<string, string> = {
      'User-Agent': this.#userAgent,
      Accept: 'application/json, text/plain, */*',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      'sec-ch-ua': SEC_CH_UA,
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': `"${SEC_CH_UA_PLATFORM}"`,
      Referer: referer,
    }

    if (semantics === 'document') {
      // 顶层导航：浏览器不带 Origin，Site 为 none
      headers['Sec-Fetch-Dest'] = 'document'
      headers['Sec-Fetch-Mode'] = 'navigate'
      headers['Sec-Fetch-Site'] = 'none'
    } else {
      headers['Sec-Fetch-Dest'] = 'empty'
      headers['Sec-Fetch-Mode'] = 'cors'
      headers['Sec-Fetch-Site'] = isSameSite(refererOrigin, target.origin)
        ? 'same-site'
        : 'cross-site'

      // 跨源 CORS 请求（**含 GET**）必须带 Origin，且 Site 必须是 same-site / cross-site。
      // 实测（M1-9）：声称 `same-origin` 却不带 Origin 的组合会被 WAF 直接判为伪造请求，
      // 返回 HTTP 412 `{"code":-412,"message":"request was banned"}`；
      // 而 `same-site` + Origin 的组合稳定返回 200。详见 docs/risk-control.md §7。
      const origin =
        options.origin === undefined
          ? crossOrigin || method !== 'GET'
            ? refererOrigin
            : undefined
          : options.origin
      if (origin !== undefined && origin !== false && origin !== '') headers.Origin = origin
    }

    let body = options.body
    if (options.form) {
      const entries: Array<[string, string]> = Object.entries(options.form).map(([key, value]) => [
        key,
        String(value),
      ])
      body = new URLSearchParams(entries).toString()
      headers['Content-Type'] = 'application/x-www-form-urlencoded'
    } else if (options.contentType) {
      headers['Content-Type'] = options.contentType
    }

    const cookie = options.cookie ?? 'auto'
    if (cookie === 'auto') {
      const value = this.#cookieProvider()
      if (value) headers.Cookie = value
    }

    return {
      url: target.toString(),
      displayUrl: redactUrl(target.toString()),
      method,
      headers: { ...headers, ...(options.headers ?? {}) },
      body,
      acceptCodes: options.acceptCodes ?? [BILI_CODE.SUCCESS],
      messageOverride: options.messageOverride,
      signal: options.signal,
      timeoutMs: options.timeoutMs ?? this.#defaultTimeoutMs,
      retryPolicy: options.retryPolicy ?? this.#defaultRetryPolicy,
      cls: options.class ?? 'api',
      label: options.label ?? target.hostname,
      redirect: options.redirect ?? 'follow',
      cookie,
    }
  }

  async #withRetry<T>(resolved: ResolvedRequest, attempt: () => Promise<T>): Promise<T> {
    try {
      return await withRetry((n) => this.#attempt(resolved, attempt, n), {
        policy: resolved.retryPolicy,
        sleep: this.#sleep,
        signal: resolved.signal,
        random: this.#random,
        onRetry: ({ attempt: n, delayMs, error }) => {
          this.#logger.warn(
            {
              label: resolved.label,
              url: resolved.displayUrl,
              attempt: n,
              delayMs,
              kind: error instanceof ApiError ? error.kind : 'unknown',
              biliCode: error instanceof ApiError ? error.biliCode : undefined,
            },
            'B站请求失败，按错误分类退避后重试',
          )
        },
      })
    } catch (err) {
      throw this.#normalizeError(err, resolved)
    }
  }

  /**
   * 取消要归一成统一错误信封。
   *
   * 取消可能发生在限速等待、退避等待或 socket 读写等任何位置，抛出的是 DOMException /
   * 自定义 reason；如果直接漏给路由层，前端会收到 500 INTERNAL 而不是"已取消"。
   */
  #normalizeError(err: unknown, resolved: ResolvedRequest): unknown {
    if (err instanceof ApiError) return err
    if (resolved.signal?.aborted) {
      return new ApiError('CANCELLED', '请求已取消', 'invalid', 499)
    }
    return err
  }

  async #attempt<T>(
    resolved: ResolvedRequest,
    attempt: () => Promise<T>,
    attemptNo: number,
  ): Promise<T> {
    try {
      return await this.limiter.run(
        resolved.cls,
        async () => {
          this.#logger.debug(
            {
              label: resolved.label,
              url: resolved.displayUrl,
              cls: resolved.cls,
              attempt: attemptNo,
              cookie: redactCookie(resolved.cookie === 'none' ? undefined : this.#cookieProvider()),
            },
            'B站请求',
          )
          return attempt()
        },
        resolved.signal,
      )
    } catch (err) {
      if (err instanceof ApiError) {
        this.#logger.warn(
          {
            label: resolved.label,
            url: resolved.displayUrl,
            kind: err.kind,
            code: err.code,
            biliCode: err.biliCode,
            status: err.httpStatus,
            message: err.message,
          },
          'B站请求失败',
        )
      }
      throw err
    }
  }

  async #dispatch(
    resolved: ResolvedRequest,
  ): Promise<{ response: Response; requestStartMs: number; requestEndMs: number }> {
    const controller = new AbortController()
    const onCallerAbort = (): void => controller.abort(resolved.signal?.reason)
    if (resolved.signal) {
      if (resolved.signal.aborted) controller.abort(resolved.signal.reason)
      else resolved.signal.addEventListener('abort', onCallerAbort, { once: true })
    }
    const timer = setTimeout(
      () =>
        controller.abort(
          new ApiError('TIMEOUT', `请求超时（${resolved.timeoutMs}ms）`, 'network', 504),
        ),
      resolved.timeoutMs,
    )

    const requestStartMs = this.#localNow()
    try {
      const response = await this.#fetch(resolved.url, {
        method: resolved.method,
        headers: resolved.headers,
        body: resolved.body,
        signal: controller.signal,
        redirect: resolved.redirect,
      })
      return { response, requestStartMs, requestEndMs: this.#localNow() }
    } catch (err) {
      if (controller.signal.aborted) {
        const reason: unknown = controller.signal.reason
        if (reason instanceof ApiError) throw reason
        if (resolved.signal?.aborted) {
          throw new ApiError('CANCELLED', '请求已取消', 'invalid', 499)
        }
        throw new ApiError('NETWORK_ERROR', '请求被中断', 'network', 502)
      }
      throw new ApiError(
        'NETWORK_ERROR',
        `网络请求失败：${err instanceof Error ? err.message : String(err)}`,
        'network',
        502,
      )
    } finally {
      clearTimeout(timer)
      resolved.signal?.removeEventListener('abort', onCallerAbort)
    }
  }

  #observeClock(response: Response, requestStartMs: number, requestEndMs: number): void {
    this.clock.observeDateHeader(response.headers.get('date'), requestStartMs, requestEndMs)
  }

  #httpError(status: number, body: string, resolved: ResolvedRequest): ApiError {
    if (looksLikeRiskPage(body) || status === 412 || status === 429) {
      return apiErrorFromHttpStatus(
        412,
        `请求被 B站风控拦截（HTTP ${status}），已按策略退避重试`,
      )
    }
    if (status >= 500) {
      return apiErrorFromHttpStatus(status, `B站服务异常（HTTP ${status}，${resolved.label}）`)
    }
    return apiErrorFromHttpStatus(status, `B站请求失败（HTTP ${status}，${resolved.label}）`)
  }

  #bodyError(status: number, body: string, resolved: ResolvedRequest): ApiError {
    if (looksLikeRiskPage(body)) {
      return new ApiError(
        'RISK_BLOCKED',
        `响应是风控页面而非数据（${resolved.label}），已按策略退避重试`,
        'risk',
        429,
        BILI_CODE.RISK_BLOCKED,
      )
    }
    return new ApiError(
      'RESPONSE_NOT_JSON',
      `B站返回的不是 JSON（HTTP ${status}，${resolved.label}）`,
      'network',
      502,
    )
  }
}
