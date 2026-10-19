/**
 * 时钟校正（ADR-10）。
 *
 * B站所有签名请求都带 `wts`，本机时钟偏差会让签名整体失效，而且报错信息
 * （通常就是 -412 / -352）完全指不到"时钟"这个原因，归因成本极高。
 * 因此我们用响应 `Date` 头估算偏差，所有 `wts` 一律取校正后的时间。
 */

/** 超过这个偏差基本可以判定是异常响应（或系统时间严重错误），不采信 */
const MAX_TRUSTED_OFFSET_MS = 24 * 60 * 60 * 1000

export class Clock {
  readonly #now: () => number
  #offsetMs = 0

  constructor(now: () => number = Date.now) {
    this.#now = now
  }

  /** 当前估算的服务端时间 - 本机时间（毫秒） */
  get offsetMs(): number {
    return this.#offsetMs
  }

  /** 校正后的本机时间（毫秒） */
  nowMs(): number {
    return this.#now() + this.#offsetMs
  }

  /** 校正后的 UNIX 秒（用于 `wts` 与 `context[ts]`） */
  nowSec(): number {
    return Math.floor(this.nowMs() / 1000)
  }

  /**
   * 用响应 `Date` 头校正偏差。
   *
   * 取本地"发出请求"与"收到响应"的中点作为本地时刻，与服务端 Date 比较：
   * 这样网络往返延迟不会被全部算进偏差里。
   * HTTP Date 只有秒级精度，因此偏差精度也在秒级 —— 对签名来说足够。
   *
   * @returns 校正后的偏差（毫秒）；未采信时返回原偏差
   */
  observeDateHeader(
    value: string | null | undefined,
    requestStartMs: number,
    requestEndMs: number,
  ): number {
    if (!value) return this.#offsetMs
    const serverMs = Date.parse(value)
    if (!Number.isFinite(serverMs)) return this.#offsetMs

    const localMidpoint = (requestStartMs + requestEndMs) / 2
    const delta = serverMs - localMidpoint
    if (Math.abs(delta) > MAX_TRUSTED_OFFSET_MS) return this.#offsetMs

    this.#offsetMs = Math.round(delta)
    return this.#offsetMs
  }

  /** 仅供测试与诊断：显式设置偏差 */
  setOffsetMs(value: number): void {
    this.#offsetMs = Number.isFinite(value) ? Math.round(value) : 0
  }
}
