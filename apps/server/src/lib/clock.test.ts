import { describe, expect, it } from 'vitest'
import { Clock } from './clock.js'

describe('时钟校正（ADR-10）', () => {
  const LOCAL = Date.parse('2026-10-16T08:30:00Z')

  it('本机时钟慢 3 秒时估算出 +3s 偏差', () => {
    const clock = new Clock(() => LOCAL)
    // HTTP Date 只有秒级精度，因此让收发时刻落在整秒上
    const offset = clock.observeDateHeader(new Date(LOCAL + 3_000).toUTCString(), LOCAL, LOCAL)
    expect(offset).toBe(3_000)
    expect(clock.offsetMs).toBe(3_000)
  })

  it('扣除网络往返：取收发中点，不把延迟算进偏差', () => {
    const clock = new Clock(() => LOCAL)
    // 请求耗时 1000ms（中点 = LOCAL + 500ms），服务端时间 = LOCAL + 3000ms
    const offset = clock.observeDateHeader(
      new Date(LOCAL + 3_000).toUTCString(),
      LOCAL,
      LOCAL + 1_000,
    )
    expect(offset).toBe(2_500)
  })

  it('nowSec 使用校正后的时间（wts 依赖它）', () => {
    const clock = new Clock(() => LOCAL)
    clock.setOffsetMs(-2_500)
    expect(clock.nowSec()).toBe(Math.floor((LOCAL - 2_500) / 1000))
  })

  it('缺失 / 非法 / 离谱的 Date 头一律忽略，保持原偏差', () => {
    const clock = new Clock(() => LOCAL)
    clock.setOffsetMs(1_234)
    expect(clock.observeDateHeader(undefined, LOCAL, LOCAL)).toBe(1_234)
    expect(clock.observeDateHeader('not-a-date', LOCAL, LOCAL)).toBe(1_234)
    // 相差 3 天：大概率是伪造/异常响应，不采信
    expect(clock.observeDateHeader(new Date(LOCAL + 3 * 86_400_000).toUTCString(), LOCAL, LOCAL)).toBe(
      1_234,
    )
  })

  it('本机时钟正确时偏差为 0（秒级精度内）', () => {
    const clock = new Clock(() => LOCAL)
    const offset = clock.observeDateHeader(new Date(LOCAL).toUTCString(), LOCAL, LOCAL)
    expect(Math.abs(offset)).toBeLessThanOrEqual(1_000)
  })
})
