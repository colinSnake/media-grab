import { BILI_CODE } from '@mediagrab/shared'
import { ApiError } from './errors.js'
import { abortError, type SleepFn } from './token-bucket.js'

/**
 * 退避重试（ADR-6：错误分类先于重试）。
 *
 * 只有 `network` / `risk` 两类可重试；`auth` / `permission` / `notFound` 重试毫无意义，
 * 只会把风控喂得更饱。
 *
 * 退避时长的两套口径（RISK §6 + 本节说明）：
 * - **后台/下载类**（`BACKGROUND_RETRY`）：严格按 RISK §6 的 30s → 60s → 120s；
 * - **交互类**（`INTERACTIVE_RETRY`，解析/取流）：首轮 2s / 8s。
 *   用户点一下解析却要等 30 秒，体验上等于"卡住"；而交互请求量极小，
 *   短退避已经足够脱离瞬时抖动，连续失败由熔断（M4-3）接管。
 */

export interface RetryPolicy {
  /** 总尝试次数（含首次），必须 ≥1 */
  maxAttempts: number
  /** 风控类失败的退避序列（毫秒），耗尽后取最后一项 */
  riskDelaysMs: readonly number[]
  /** 网络类失败的退避序列（毫秒） */
  networkDelaysMs: readonly number[]
  /** 抖动比例 0–1：对退避时长做 ±ratio 的随机抖动，避免同步重试 */
  jitterRatio: number
}

/** RISK §6 的风控退避序列 */
export const RISK_BACKOFF_MS = [30_000, 60_000, 120_000] as const

/** 交互式请求（/api/parse、/api/playurl）：短退避，避免用户对着转圈等 30 秒 */
export const INTERACTIVE_RETRY: RetryPolicy = {
  maxAttempts: 3,
  riskDelaysMs: [2_000, 8_000],
  networkDelaysMs: [500, 1_500],
  jitterRatio: 0.2,
}

/** 后台/下载类请求：按 RISK §6 的完整退避 */
export const BACKGROUND_RETRY: RetryPolicy = {
  maxAttempts: 4,
  riskDelaysMs: RISK_BACKOFF_MS,
  networkDelaysMs: [1_000, 4_000, 10_000],
  jitterRatio: 0.25,
}

/** 是否值得重试：分类说话，不看错误文案 */
export function isRetryable(err: unknown): boolean {
  return err instanceof ApiError && err.retryable
}

/**
 * 本次错误允许的最大尝试次数。
 *
 * `-352`（需要 v_voucher 的风控校验）RISK §6 明确"退避后重试 1 次；仍失败则暂停并提示"，
 * 因此它的尝试次数被压到 2（首次 + 1 次重试）。
 */
export function maxAttemptsFor(err: unknown, policy: RetryPolicy): number {
  if (err instanceof ApiError && err.biliCode === BILI_CODE.RISK_VOUCHER) {
    return Math.max(1, Math.min(policy.maxAttempts, 2))
  }
  return Math.max(1, policy.maxAttempts)
}

/**
 * 第 `attempt` 次失败后的等待时长（毫秒）。`attempt` 从 1 开始。
 */
export function retryDelayMs(
  err: unknown,
  attempt: number,
  policy: RetryPolicy,
  random: () => number = Math.random,
): number {
  const kind = err instanceof ApiError ? err.kind : 'network'
  const series = kind === 'risk' ? policy.riskDelaysMs : policy.networkDelaysMs
  const base = series.length > 0 ? (series[Math.min(attempt, series.length) - 1] ?? 0) : 0
  if (base <= 0 || policy.jitterRatio <= 0) return Math.max(0, Math.round(base))

  // 对称抖动：base * (1 ± ratio)，下限 0
  const factor = 1 + (random() * 2 - 1) * policy.jitterRatio
  return Math.max(0, Math.round(base * factor))
}

export interface RetryInfo {
  attempt: number
  delayMs: number
  error: unknown
}

export interface WithRetryOptions {
  policy: RetryPolicy
  sleep: SleepFn
  signal?: AbortSignal
  /** 每次决定重试时回调（用于日志与可观测） */
  onRetry?: (info: RetryInfo) => void
  random?: () => number
}

/**
 * 按策略执行 `fn`，失败时按分类决定是否重试。
 * `fn` 的参数是当前尝试序号（从 1 开始），便于把 attempt 带进日志。
 */
export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  options: WithRetryOptions,
): Promise<T> {
  const { policy, sleep, signal } = options
  let attempt = 1
  for (;;) {
    if (signal?.aborted) throw abortError(signal)
    try {
      return await fn(attempt)
    } catch (err) {
      const max = maxAttemptsFor(err, policy)
      if (!isRetryable(err) || attempt >= max) throw err
      const delayMs = retryDelayMs(err, attempt, policy, options.random)
      options.onRetry?.({ attempt, delayMs, error: err })
      await sleep(delayMs, signal)
      attempt += 1
    }
  }
}
