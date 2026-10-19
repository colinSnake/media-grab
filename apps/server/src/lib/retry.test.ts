import { BILI_CODE } from '@mediagrab/shared'
import { describe, expect, it } from 'vitest'
import { ApiError } from './errors.js'
import {
  BACKGROUND_RETRY,
  INTERACTIVE_RETRY,
  isRetryable,
  maxAttemptsFor,
  retryDelayMs,
  withRetry,
} from './retry.js'

const risk = (biliCode: number = BILI_CODE.RISK_BLOCKED): ApiError =>
  new ApiError('RISK_BLOCKED', '风控', 'risk', 429, biliCode)
const network = (): ApiError => new ApiError('NETWORK_ERROR', '网络', 'network', 502)
const auth = (): ApiError => new ApiError('BILI_AUTH', '未登录', 'auth', 403, BILI_CODE.NOT_LOGIN)
const permission = (): ApiError =>
  new ApiError('BILI_PERMISSION', '无权限', 'permission', 403, BILI_CODE.NO_PERMISSION)

/** 无抖动的确定性随机源 */
const noJitter = (): number => 0.5

describe('错误分类先于重试（ADR-6）', () => {
  it('只有 network / risk 可重试', () => {
    expect(isRetryable(network())).toBe(true)
    expect(isRetryable(risk())).toBe(true)
    expect(isRetryable(auth())).toBe(false)
    expect(isRetryable(permission())).toBe(false)
    expect(isRetryable(new Error('普通错误'))).toBe(false)
  })

  it('退避序列按分类选取（风控 30s→60s→120s）', () => {
    const policy = BACKGROUND_RETRY
    expect(retryDelayMs(risk(), 1, policy, noJitter)).toBe(30_000)
    expect(retryDelayMs(risk(), 2, policy, noJitter)).toBe(60_000)
    expect(retryDelayMs(risk(), 3, policy, noJitter)).toBe(120_000)
    // 超出序列长度后取最后一项，不再无限增长
    expect(retryDelayMs(risk(), 9, policy, noJitter)).toBe(120_000)
    expect(retryDelayMs(network(), 1, policy, noJitter)).toBe(1_000)
  })

  it('抖动在 ±ratio 范围内，且不为负', () => {
    const low = retryDelayMs(risk(), 1, BACKGROUND_RETRY, () => 0)
    const high = retryDelayMs(risk(), 1, BACKGROUND_RETRY, () => 1)
    expect(low).toBe(Math.round(30_000 * 0.75))
    expect(high).toBe(Math.round(30_000 * 1.25))
    expect(retryDelayMs(network(), 1, { ...INTERACTIVE_RETRY, networkDelaysMs: [0] }, noJitter)).toBe(0)
  })

  it('-352（需要 v_voucher）最多退避重试 1 次（RISK §6）', () => {
    expect(maxAttemptsFor(risk(BILI_CODE.RISK_VOUCHER), BACKGROUND_RETRY)).toBe(2)
    expect(maxAttemptsFor(risk(), BACKGROUND_RETRY)).toBe(BACKGROUND_RETRY.maxAttempts)
  })
})

describe('withRetry', () => {
  it('可重试错误在成功前会退避重试，并回调 onRetry', async () => {
    const sleeps: number[] = []
    const retries: number[] = []
    let attempts = 0
    const result = await withRetry(
      async (attempt) => {
        attempts = attempt
        if (attempt < 3) throw network()
        return 'ok'
      },
      {
        policy: INTERACTIVE_RETRY,
        sleep: async (ms) => {
          sleeps.push(ms)
        },
        random: noJitter,
        onRetry: ({ attempt }) => retries.push(attempt),
      },
    )
    expect(result).toBe('ok')
    expect(attempts).toBe(3)
    expect(retries).toEqual([1, 2])
    expect(sleeps).toEqual([500, 1_500])
  })

  it('不可重试错误立刻抛出，不做任何等待', async () => {
    const sleeps: number[] = []
    await expect(
      withRetry(
        async () => {
          throw auth()
        },
        { policy: INTERACTIVE_RETRY, sleep: async (ms) => void sleeps.push(ms) },
      ),
    ).rejects.toBeInstanceOf(ApiError)
    expect(sleeps).toEqual([])
  })

  it('达到上限后抛出最后一次错误', async () => {
    let calls = 0
    await expect(
      withRetry(
        async () => {
          calls += 1
          throw risk()
        },
        { policy: { ...INTERACTIVE_RETRY, maxAttempts: 2 }, sleep: async () => {}, random: noJitter },
      ),
    ).rejects.toBeInstanceOf(ApiError)
    expect(calls).toBe(2)
  })

  it('退避期间取消会立即结束', async () => {
    const controller = new AbortController()
    await expect(
      withRetry(
        async () => {
          throw network()
        },
        {
          policy: INTERACTIVE_RETRY,
          signal: controller.signal,
          sleep: async (_ms, signal) => {
            controller.abort()
            if (signal?.aborted) throw signal.reason ?? new Error('aborted')
          },
        },
      ),
    ).rejects.toBeDefined()
  })
})
