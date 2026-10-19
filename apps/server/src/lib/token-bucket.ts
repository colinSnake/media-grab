/**
 * 限速地基（NFR-04 / RISK §5）。
 *
 * 两个正交的约束，必须同时满足：
 * 1. **最小间隔**（令牌桶）：`api.bilibili.com` 全局 ≥300ms；`passport` 轮询 ≥2s。
 * 2. **并发上限**（信号量）：`playurl` ≤2，其它 API ≤4，`passport` =1。
 *
 * 绝不能把下载并发（CDN）算进这里：CDN 走各自的下载引擎，不受本模块约束。
 */

export type SleepFn = (ms: number, signal?: AbortSignal) => Promise<void>

/** 取消原因统一成 AbortError，避免各处自己拼字符串 */
export function abortError(signal?: AbortSignal): unknown {
  if (signal?.reason !== undefined) return signal.reason
  return new DOMException('操作已取消', 'AbortError')
}

export const defaultSleep: SleepFn = (ms, signal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError(signal))
      return
    }
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(abortError(signal))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })

export interface TokenBucketOptions {
  /** 两次取令牌之间的最小间隔；0 表示不限速 */
  minIntervalMs?: number
  /** 桶容量：允许的突发次数 */
  capacity?: number
  now?: () => number
  sleep?: SleepFn
}

/**
 * 令牌桶。
 *
 * 容量默认为 1，等价于"严格最小间隔"—— 这正是 RISK §5 想要的语义：
 * 不需要突发能力，只要保证相邻请求不挨得太近。
 */
export class TokenBucket {
  readonly #minIntervalMs: number
  readonly #capacity: number
  readonly #now: () => number
  readonly #sleep: SleepFn
  #tokens: number
  #lastRefillMs: number

  constructor(options: TokenBucketOptions = {}) {
    this.#minIntervalMs = Math.max(0, options.minIntervalMs ?? 300)
    this.#capacity = Math.max(1, options.capacity ?? 1)
    this.#now = options.now ?? Date.now
    this.#sleep = options.sleep ?? defaultSleep
    this.#tokens = this.#capacity
    this.#lastRefillMs = this.#now()
  }

  get minIntervalMs(): number {
    return this.#minIntervalMs
  }

  #refill(): void {
    if (this.#minIntervalMs === 0) {
      this.#tokens = this.#capacity
      return
    }
    const now = this.#now()
    const elapsed = now - this.#lastRefillMs
    if (elapsed <= 0) return
    this.#lastRefillMs = now
    this.#tokens = Math.min(this.#capacity, this.#tokens + elapsed / this.#minIntervalMs)
  }

  /** 非阻塞取令牌（有就立刻拿走，没有返回 false） */
  tryAcquire(): boolean {
    this.#refill()
    if (this.#tokens >= 1) {
      this.#tokens -= 1
      return true
    }
    return false
  }

  /** 阻塞取令牌；等待期间可被 AbortSignal 取消 */
  async acquire(signal?: AbortSignal): Promise<void> {
    for (;;) {
      if (signal?.aborted) throw abortError(signal)
      if (this.#minIntervalMs === 0) return
      this.#refill()
      if (this.#tokens >= 1) {
        this.#tokens -= 1
        return
      }
      const waitMs = Math.max(1, Math.ceil((1 - this.#tokens) * this.#minIntervalMs))
      await this.#sleep(waitMs, signal)
    }
  }
}

interface Waiter {
  resolve: () => void
  reject: (err: unknown) => void
  signal?: AbortSignal
  onAbort?: () => void
}

/** 并发上限（信号量）：超出部分排队，而不是失败 */
export class ConcurrencyLimiter {
  readonly #limit: number
  readonly #queue: Waiter[] = []
  #active = 0

  constructor(limit: number) {
    this.#limit = Math.max(1, Math.floor(limit))
  }

  get limit(): number {
    return this.#limit
  }

  get active(): number {
    return this.#active
  }

  get queued(): number {
    return this.#queue.length
  }

  async #acquireSlot(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw abortError(signal)
    if (this.#active < this.#limit) {
      this.#active += 1
      return
    }
    await new Promise<void>((resolve, reject) => {
      const waiter: Waiter = { resolve, reject, signal }
      if (signal) {
        waiter.onAbort = (): void => {
          const index = this.#queue.indexOf(waiter)
          if (index >= 0) this.#queue.splice(index, 1)
          reject(abortError(signal))
        }
        signal.addEventListener('abort', waiter.onAbort, { once: true })
      }
      this.#queue.push(waiter)
    })
    // 插槽由 #release 直接移交（active 计数已 +1），这里不需要再自增
  }

  #release(): void {
    const next = this.#queue.shift()
    if (!next) {
      this.#active -= 1
      return
    }
    if (next.onAbort && next.signal) next.signal.removeEventListener('abort', next.onAbort)
    // 插槽不释放，直接交给队首等待者
    next.resolve()
  }

  async run<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    await this.#acquireSlot(signal)
    try {
      return await fn()
    } finally {
      this.#release()
    }
  }
}

/**
 * 限速类别。
 * - `playurl`：取流接口，最敏感（RISK §5 要求 ≤2 并发）
 * - `api`：其它 api.bilibili.com 接口
 * - `passport`：扫码轮询，独立 2s 间隔
 * - `other`：www.bilibili.com / b23.tv 等非 api 域
 */
export type RateLimitClass = 'playurl' | 'api' | 'passport' | 'other'

export const DEFAULT_CLASS_CONCURRENCY: Readonly<Record<RateLimitClass, number>> = {
  playurl: 2,
  api: 4,
  passport: 1,
  other: 4,
}

export interface BiliRateLimiterOptions {
  /** api.bilibili.com 的全局最小间隔，默认 300ms（RISK §5 下限） */
  apiMinIntervalMs?: number
  /** passport 轮询最小间隔，默认 2000ms */
  passportMinIntervalMs?: number
  /** 各类别并发上限覆盖 */
  concurrency?: Partial<Record<RateLimitClass, number>>
  now?: () => number
  sleep?: SleepFn
}

/** 把"最小间隔 + 并发上限"合成一个入口：出网层只调用 run() */
export class BiliRateLimiter {
  readonly #sharedBucket: TokenBucket
  readonly #passportBucket: TokenBucket
  readonly #limiters: Record<RateLimitClass, ConcurrencyLimiter>

  constructor(options: BiliRateLimiterOptions = {}) {
    const now = options.now ?? Date.now
    const sleep = options.sleep ?? defaultSleep
    this.#sharedBucket = new TokenBucket({
      minIntervalMs: options.apiMinIntervalMs ?? 300,
      now,
      sleep,
    })
    this.#passportBucket = new TokenBucket({
      minIntervalMs: options.passportMinIntervalMs ?? 2_000,
      now,
      sleep,
    })

    const build = (cls: RateLimitClass): ConcurrencyLimiter =>
      new ConcurrencyLimiter(options.concurrency?.[cls] ?? DEFAULT_CLASS_CONCURRENCY[cls])
    this.#limiters = {
      playurl: build('playurl'),
      api: build('api'),
      passport: build('passport'),
      other: build('other'),
    }
  }

  /** 在指定类别的限速约束下执行（先占并发槽，再等最小间隔） */
  async run<T>(cls: RateLimitClass, fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const limiter = this.#limiters[cls]
    const bucket = cls === 'passport' ? this.#passportBucket : this.#sharedBucket
    return limiter.run(async () => {
      await bucket.acquire(signal)
      return fn()
    }, signal)
  }

  stats(): Record<
    RateLimitClass,
    { limit: number; active: number; queued: number; minIntervalMs: number }
  > {
    const of = (
      cls: RateLimitClass,
    ): { limit: number; active: number; queued: number; minIntervalMs: number } => ({
      limit: this.#limiters[cls].limit,
      active: this.#limiters[cls].active,
      queued: this.#limiters[cls].queued,
      minIntervalMs:
        cls === 'passport' ? this.#passportBucket.minIntervalMs : this.#sharedBucket.minIntervalMs,
    })
    return {
      playurl: of('playurl'),
      api: of('api'),
      passport: of('passport'),
      other: of('other'),
    }
  }
}
