import { MockAgent, getGlobalDispatcher, setGlobalDispatcher, type Dispatcher, type MockPool } from 'undici'
import { beforeEach, afterEach, describe, expect, it } from 'vitest'
import { BiliRateLimiter } from '../lib/token-bucket.js'
import { Database } from '../store/db.js'
import { WbiKeyRepository } from '../store/repositories.js'
import { makeFakeClock } from '../testing/fake-fetch.js'
import { BiliHttp } from './http.js'
import { fetchPlayurl } from './playurl.js'
import { WbiKeyService } from './wbi.js'

/**
 * 取流解析走 undici **MockAgent**（TECH §8 的指定方式）：全局 fetch 被拦截，
 * 测试全程不触网。真实匿名实测的基线数据（BV1GJ411x7h7）在这里作为夹具复用。
 */

const IMG_KEY = '7cd084941338484aae1ad9425b84077c'
const SUB_KEY = '4932caff0ff746eab6f01bf08b70ac45'

const NAV_JSON = JSON.stringify({
  code: -101,
  message: '账号未登录',
  data: {
    isLogin: false,
    wbi_img: {
      img_url: `https://i0.hdslb.com/bfs/wbi/${IMG_KEY}.png`,
      sub_url: `https://i0.hdslb.com/bfs/wbi/${SUB_KEY}.png`,
    },
  },
})

/** 实测基线：声明 5 档（含 1080P+），实际只交付 360P/480P */
function playurlBody(overrides: {
  accept?: number[]
  videoIds?: number[]
  audioIds?: number[]
  duration?: number
  omitDash?: boolean
  code?: number
  message?: string
} = {}): string {
  const {
    accept = [112, 80, 64, 32, 16],
    videoIds = [32, 32, 16],
    audioIds = [30280, 30232, 30216],
    duration = 213,
    omitDash = false,
    code = 0,
    message = '0',
  } = overrides

  if (omitDash) return JSON.stringify({ code, message, data: { accept_quality: accept } })

  return JSON.stringify({
    code,
    message,
    data: {
      quality: 64,
      accept_quality: accept,
      accept_description: accept.map((qn) => `${qn}P`),
      dash: {
        duration,
        video: videoIds.map((id, index) => ({
          id,
          codecid: index % 2 === 0 ? 7 : 12,
          base_url: `https://cdn.example.com/v-${id}-${index}.m4s`,
          width: 852,
          height: 480,
          bandwidth: 1_000_000,
        })),
        audio: audioIds.map((id) => ({ id, base_url: `https://cdn.example.com/a-${id}.m4s` })),
      },
    },
  })
}

interface Harness {
  http: BiliHttp
  wbi: WbiKeyService
  db: Database
  clock: ReturnType<typeof makeFakeClock>
  playurlPaths: string[]
  playurlCalls: () => number
}

function build(): Harness {
  const clock = makeFakeClock()
  const db = Database.open(':memory:')
  const http = new BiliHttp({
    limiter: new BiliRateLimiter({ apiMinIntervalMs: 0, passportMinIntervalMs: 0 }),
    sleep: clock.sleep,
    localNow: clock.now,
    // 抖动固定：断言退避序列时要的是"策略正确"，不是随机数
    random: () => 0.5,
  })
  const wbi = new WbiKeyService({ http, repo: new WbiKeyRepository(db) })
  return { http, wbi, db, clock, playurlPaths: [], playurlCalls: () => state.calls }
}

let mock: MockAgent
let pool: MockPool
let previous: Dispatcher
const state = { calls: 0 }

beforeEach(() => {
  previous = getGlobalDispatcher()
  mock = new MockAgent()
  mock.disableNetConnect()
  setGlobalDispatcher(mock)
  pool = mock.get('https://api.bilibili.com')
  state.calls = 0
  pool
    .intercept({ path: '/x/web-interface/nav', method: 'GET' })
    .reply(200, NAV_JSON, { headers: { 'content-type': 'application/json' } })
    .persist()
})

afterEach(async () => {
  setGlobalDispatcher(previous)
  await mock.close()
})

/** playurl 拦截器：回调里可以按调用次数返回不同结果（模拟 -412 风控后恢复） */
function interceptPlayurl(reply: (call: number) => { statusCode: number; body: string; html?: boolean }): { paths: string[] } {
  const paths: string[] = []
  pool
    .intercept({ path: (path: string) => path.startsWith('/x/player/wbi/playurl'), method: 'GET' })
    .reply((options) => {
      state.calls += 1
      paths.push(options.path)
      const result = reply(state.calls)
      return {
        statusCode: result.statusCode,
        data: result.body,
        responseOptions: {
          headers: { 'content-type': result.html === true ? 'text/html' : 'application/json' },
        },
      }
    })
    .persist()
  return { paths }
}

describe('取流与档位可用性（ADR-12：以实际交付为准）', () => {
  it('成功解析：可用档位只看 dash.video[].id，声明的高档位标注登录/会员', async () => {
    interceptPlayurl(() => ({ statusCode: 200, body: playurlBody() }))
    const { http, wbi, db } = build()

    const bundle = await fetchPlayurl(http, wbi, { bvid: 'BV1GJ411x7h7', cid: 137649199 })

    const byQn = new Map(bundle.qualities.map((item) => [item.qn, item]))
    expect(bundle.qualities.map((item) => item.qn)).toEqual([112, 80, 64, 32, 16])
    expect(byQn.get(32)?.available).toBe(true)
    expect(byQn.get(16)?.available).toBe(true)
    // 声明支持但未交付：720P/1080P 标注登录，1080P+ 标注会员
    expect(byQn.get(64)?.state).toBe('need-login')
    expect(byQn.get(80)?.state).toBe('need-login')
    expect(byQn.get(112)?.state).toBe('need-vip')
    expect(byQn.get(112)?.reason).toBe('需要大会员')

    expect(bundle.durationSec).toBe(213)
    expect(bundle.urlTtlSec).toBe(7_200)
    expect(bundle.video.map((item) => item.id)).toEqual([32, 32, 16])
    expect(bundle.video.every((item) => item.url.startsWith('https://cdn.example.com/'))).toBe(true)
    expect(bundle.audio.map((item) => item.id)).toEqual([30280, 30232, 30216])

    const audioByQn = new Map(bundle.audioQualities.map((item) => [item.id, item]))
    expect(bundle.audioQualities.filter((item) => item.available).map((item) => item.id)).toEqual([
      30280, 30232, 30216,
    ])
    expect(audioByQn.get(30250)?.state).toBe('need-vip')
    expect(audioByQn.get(30251)?.state).toBe('need-vip')

    db.close()
  })

  it('请求带 WBI 签名（w_rid + wts）与全开位掩码', async () => {
    const { paths } = interceptPlayurl(() => ({ statusCode: 200, body: playurlBody() }))
    const { http, wbi, db } = build()
    await fetchPlayurl(http, wbi, { bvid: 'BV1GJ411x7h7', cid: 137649199 })

    const path = paths[0] ?? ''
    expect(path).toContain('w_rid=')
    expect(path).toContain('wts=')
    expect(path).toContain('qn=127')
    expect(path).toContain('fnval=4048')
    expect(path).toContain('fourk=1')
    expect(path).toContain('bvid=BV1GJ411x7h7')
    expect(path).toContain('cid=137649199')
    db.close()
  })

  it('即使声明 1080P，只要没交付就绝不可用（防"显示可下、下载失败"）', async () => {
    interceptPlayurl(() => ({ statusCode: 200, body: playurlBody({ videoIds: [16], accept: [80, 64, 16] }) }))
    const { http, wbi, db } = build()
    const bundle = await fetchPlayurl(http, wbi, { bvid: 'BV1GJ411x7h7', cid: 1 })

    expect(bundle.qualities.filter((item) => item.available).map((item) => item.qn)).toEqual([16])
    expect(bundle.qualities.find((item) => item.qn === 80)?.state).toBe('need-login')
    db.close()
  })

  it('没有可用 URL 的流不进候选列表，但仍计入"已交付"', async () => {
    const body = JSON.parse(playurlBody({ videoIds: [32] })) as Record<string, unknown>
    // 去掉 base_url：该流算交付（可用性为真），但不给前端一个下不了的地址
    const dash = (body['data'] as { dash: { video: Array<Record<string, unknown>> } }).dash
    delete dash.video[0]?.['base_url']

    interceptPlayurl(() => ({ statusCode: 200, body: JSON.stringify(body) }))
    const { http, wbi, db } = build()
    const bundle = await fetchPlayurl(http, wbi, { bvid: 'BV1GJ411x7h7', cid: 1 })

    expect(bundle.qualities.find((item) => item.qn === 32)?.available).toBe(true)
    expect(bundle.video).toHaveLength(0)
    db.close()
  })

  it('未返回 dash 时明确失败，绝不静默降级（ADR-7）', async () => {
    interceptPlayurl(() => ({ statusCode: 200, body: playurlBody({ omitDash: true }) }))
    const { http, wbi, db } = build()
    await expect(
      fetchPlayurl(http, wbi, { bvid: 'BV1GJ411x7h7', cid: 1 }),
    ).rejects.toMatchObject({ code: 'NO_DASH_STREAM', kind: 'fatal' })
    db.close()
  })
})

describe('风控与权限错误的处理（RISK §6）', () => {
  it('-412 退避后重试成功，最终返回结果', async () => {
    interceptPlayurl((call) =>
      call <= 2
        ? { statusCode: 412, body: '<html>出错啦! 请求被拦截</html>', html: true }
        : { statusCode: 200, body: playurlBody() },
    )
    const { http, wbi, db, clock } = build()
    const bundle = await fetchPlayurl(http, wbi, { bvid: 'BV1GJ411x7h7', cid: 1 })

    expect(bundle.qualities.some((item) => item.available)).toBe(true)
    expect(state.calls).toBe(3)
    // 交互式策略：2s → 8s（而不是让用户干等 30s）
    expect(clock.sleeps).toEqual([2_000, 8_000])
    db.close()
  })

  it('-101（需要登录）不重试，立刻按 auth 类失败', async () => {
    interceptPlayurl(() => ({ statusCode: 200, body: playurlBody({ code: -101, message: '账号未登录' }) }))
    const { http, wbi, db } = build()
    await expect(
      fetchPlayurl(http, wbi, { bvid: 'BV1GJ411x7h7', cid: 1 }),
    ).rejects.toMatchObject({ kind: 'auth', retryable: false, biliCode: -101 })
    expect(state.calls).toBe(1)
    db.close()
  })

  it('-403（需要大会员）不重试，文案如实说明', async () => {
    interceptPlayurl(() => ({ statusCode: 200, body: playurlBody({ code: -403, message: 'no permission' }) }))
    const { http, wbi, db } = build()
    await expect(
      fetchPlayurl(http, wbi, { bvid: 'BV1GJ411x7h7', cid: 1 }),
    ).rejects.toMatchObject({ kind: 'permission', retryable: false })
    db.close()
  })
})
