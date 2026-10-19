import { describe, expect, it } from 'vitest'
import { makeFakeClock } from '../testing/fake-fetch.js'
import {
  BiliRateLimiter,
  ConcurrencyLimiter,
  TokenBucket,
  abortError,
  defaultSleep,
} from './token-bucket.js'

describe('令牌桶：最小间隔', () => {
  it('容量 1 时第二次取令牌必须等待一个间隔', async () => {
    const clock = makeFakeClock()
    const bucket = new TokenBucket({
      minIntervalMs: 300,
      now: clock.now,
      sleep: clock.sleep,
    })

    expect(bucket.tryAcquire()).toBe(true)
    expect(bucket.tryAcquire()).toBe(false)

    await bucket.acquire()
    expect(clock.sleeps).toEqual([300])
  })

  it('容量 >1 允许突发，用完后回到间隔约束', async () => {
    const clock = makeFakeClock()
    const bucket = new TokenBucket({ minIntervalMs: 100, capacity: 3, now: clock.now, sleep: clock.sleep })
    expect(bucket.tryAcquire()).toBe(true)
    expect(bucket.tryAcquire()).toBe(true)
    expect(bucket.tryAcquire()).toBe(true)
    expect(bucket.tryAcquire()).toBe(false)
    await bucket.acquire()
    expect(clock.sleeps).toEqual([100])
  })

  it('间隔为 0 表示不限速', async () => {
    const bucket = new TokenBucket({ minIntervalMs: 0 })
    await bucket.acquire()
    await bucket.acquire()
    expect(bucket.tryAcquire()).toBe(true)
  })

  it('已取消的 signal 直接拒绝，不占用等待', async () => {
    const clock = makeFakeClock()
    const bucket = new TokenBucket({ minIntervalMs: 300, now: clock.now, sleep: clock.sleep })
    bucket.tryAcquire()
    const controller = new AbortController()
    controller.abort()
    await expect(bucket.acquire(controller.signal)).rejects.toBeDefined()
    expect(clock.sleeps).toEqual([])
  })
})

/** 让出事件循环，等真实定时器/微任务把状态推进到位 */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

/** 手动放行的闸门：用于精确观测"并发上限" */
class Gate {
  #waiters: Array<() => void> = []

  get pending(): number {
    return this.#waiters.length
  }

  wait(): Promise<void> {
    return new Promise<void>((resolve) => this.#waiters.push(resolve))
  }

  open(): void {
    const waiters = this.#waiters
    this.#waiters = []
    for (const resolve of waiters) resolve()
  }
}

describe('并发上限', () => {
  it('超出上限的任务排队而不是失败，且并发不超过上限', async () => {
    const limiter = new ConcurrencyLimiter(2)
    const gate = new Gate()
    let active = 0
    let peak = 0

    const task = async (): Promise<void> => {
      active += 1
      peak = Math.max(peak, active)
      await gate.wait()
      active -= 1
    }

    const running = [limiter.run(task), limiter.run(task), limiter.run(task)]
    await flush()

    expect(limiter.active).toBe(2)
    expect(limiter.queued).toBe(1)
    expect(peak).toBe(2)

    gate.open()
    await flush()
    gate.open()
    await flush()

    await Promise.all(running)
    expect(peak).toBe(2)
    expect(limiter.active).toBe(0)
    expect(limiter.queued).toBe(0)
  })

  it('运行中取消会释放插槽，排队中取消会退出队列', async () => {
    const limiter = new ConcurrencyLimiter(1)
    const first = new AbortController()
    const second = new AbortController()
    const gate = new Gate()

    const running = limiter.run(() => gate.wait(), first.signal)
    await flush()
    const queued = limiter.run(async () => 'never', second.signal)
    expect(limiter.queued).toBe(1)

    second.abort()
    await expect(queued).rejects.toBeDefined()
    expect(limiter.queued).toBe(0)

    gate.open()
    await running
    expect(limiter.active).toBe(0)
  })
})

describe('BiliRateLimiter：最小间隔 + 并发上限一起生效', () => {
  it('默认间隔符合 RISK §5：api 300ms、passport 2000ms', () => {
    const stats = new BiliRateLimiter().stats()
    expect(stats.playurl.minIntervalMs).toBe(300)
    expect(stats.passport.minIntervalMs).toBe(2_000)
  })

  it('playurl 并发上限为 2（RISK §5），超出排队', async () => {
    const limiter = new BiliRateLimiter({ apiMinIntervalMs: 0, passportMinIntervalMs: 0 })
    const gate = new Gate()
    const block = (): Promise<void> => gate.wait()

    const running = [
      limiter.run('playurl', block),
      limiter.run('playurl', block),
      limiter.run('playurl', block),
    ]
    await flush()

    expect(limiter.stats().playurl.active).toBe(2)
    expect(limiter.stats().playurl.queued).toBe(1)
    expect(gate.pending).toBe(2)

    gate.open()
    await flush()
    gate.open()
    await flush()

    await Promise.all(running)
    expect(limiter.stats().playurl.active).toBe(0)
  })

  it('run 会串行化同一类别的请求（最小间隔 300ms）', async () => {
    const clock = makeFakeClock()
    const limiter = new BiliRateLimiter({
      apiMinIntervalMs: 300,
      now: clock.now,
      sleep: clock.sleep,
    })
    await limiter.run('api', async () => 1)
    await limiter.run('api', async () => 2)
    // 第二次请求至少等待 300ms
    expect(clock.sleeps).toEqual([300])
  })
})

describe('defaultSleep', () => {
  it('可被 AbortSignal 打断', async () => {
    const controller = new AbortController()
    const pending = defaultSleep(10_000, controller.signal)
    controller.abort()
    await expect(pending).rejects.toBeDefined()
  })

  it('abortError 返回取消原因', () => {
    const controller = new AbortController()
    controller.abort(new Error('自定义取消原因'))
    const err = abortError(controller.signal)
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toBe('自定义取消原因')
  })
})
