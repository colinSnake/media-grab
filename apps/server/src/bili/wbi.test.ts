import { describe, expect, it } from 'vitest'
import { BiliHttp } from './http.js'
import { MIXIN_KEY_ENC_TAB, WbiKeyService, mixinKeyFrom, signWbiParams, wbiKeyFromUrl } from './wbi.js'
import { WbiKeyRepository } from '../store/repositories.js'
import { Database } from '../store/db.js'
import { BiliRateLimiter } from '../lib/token-bucket.js'
import { FakeFetch, makeFakeClock } from '../testing/fake-fetch.js'

/**
 * WBI 黄金向量。
 *
 * 这里的两个期望值都来自**真实接口实测**（M1-9，2026-10-16）：
 * - mixin key：匿名 `nav` 返回的 img/sub key 经置换表得出；
 * - w_rid：用该 mixin key + wts 签名后请求 `x/player/wbi/playurl`，服务端返回 `code=0`，
 *   说明签名与线上算法一致 —— 这不是"自己算自己"的循环验证。
 */
const REAL_IMG_KEY = '7cd084941338484aae1ad9425b84077c'
const REAL_SUB_KEY = '4932caff0ff746eab6f01bf08b70ac45'
const REAL_MIXIN_KEY = 'ea1db124af3c7062474693fa704f4ff8'
const REAL_WTS = 1_792_139_575
const REAL_QUERY = 'bvid=BV1GJ411x7h7&cid=137649199&fnval=4048&fnver=0&fourk=1&qn=127&wts=1792139575'
const REAL_W_RID = '6b5263dda9a503ec188dc5f5c5c5bc7a'
/** 真正发出去的查询串：签名后必须把 w_rid 拼上（漏掉会被服务端拒绝） */
const REAL_SIGNED_QUERY = `${REAL_QUERY}&w_rid=${REAL_W_RID}`

const NAV_JSON = {
  code: -101,
  message: '账号未登录',
  data: {
    isLogin: false,
    wbi_img: {
      img_url: `https://i0.hdslb.com/bfs/wbi/${REAL_IMG_KEY}.png`,
      sub_url: `https://i0.hdslb.com/bfs/wbi/${REAL_SUB_KEY}.png`,
    },
  },
}

function buildWbi(fake: FakeFetch, clock = makeFakeClock()) {
  const db = Database.open(':memory:')
  const repo = new WbiKeyRepository(db)
  const http = new BiliHttp({
    fetchImpl: fake.fetchImpl,
    limiter: new BiliRateLimiter({ apiMinIntervalMs: 0, passportMinIntervalMs: 0 }),
    sleep: clock.sleep,
    localNow: clock.now,
  })
  return { db, repo, http, wbi: new WbiKeyService({ http, repo }), clock }
}

describe('WBI 签名算法', () => {
  it('置换表长度为 64（取前 32 位作为 mixin key）', () => {
    expect(MIXIN_KEY_ENC_TAB).toHaveLength(64)
    expect(new Set(MIXIN_KEY_ENC_TAB).size).toBe(64)
  })

  it('真实 nav key → mixin key（线上实测值）', () => {
    expect(mixinKeyFrom(REAL_IMG_KEY, REAL_SUB_KEY)).toBe(REAL_MIXIN_KEY)
  })

  it('真实请求 → 与线上一致的 w_rid，且 query 自带 w_rid', () => {
    const signed = signWbiParams(
      { bvid: 'BV1GJ411x7h7', cid: 137649199, qn: 127, fnval: 4048, fnver: 0, fourk: 1 },
      REAL_MIXIN_KEY,
      REAL_WTS,
    )
    expect(signed.query).toBe(REAL_SIGNED_QUERY)
    expect(signed.w_rid).toBe(REAL_W_RID)
    // w_rid 必须真的在待发送的查询串里，而不只是返回值的一个字段
    expect(signed.query.endsWith(`w_rid=${REAL_W_RID}`)).toBe(true)
  })

  it('参数顺序不影响结果（签名前会排序）', () => {
    const a = signWbiParams({ b: '2', a: '1' }, REAL_MIXIN_KEY, REAL_WTS)
    const b = signWbiParams({ a: '1', b: '2' }, REAL_MIXIN_KEY, REAL_WTS)
    expect(a.query).toBe(b.query)
    expect(a.w_rid).toBe(b.w_rid)
  })

  it('值里的 !\'()* 会被过滤（与前端一致）', () => {
    const signed = signWbiParams({ keyword: "a!b'c(d)e*f" }, REAL_MIXIN_KEY, REAL_WTS)
    expect(signed.query).toContain('keyword=abcdef')
  })

  it('从 wbi_img URL 取 key', () => {
    expect(wbiKeyFromUrl('https://i0.hdslb.com/bfs/wbi/abc123.png')).toBe('abc123')
    expect(wbiKeyFromUrl('https://i0.hdslb.com/bfs/wbi/abc123')).toBe('abc123')
  })
})

describe('WbiKeyService：自然日轮换与降级', () => {
  it('首次取 key 会请求 nav（匿名 -101 必须放行）并落库', async () => {
    const fake = new FakeFetch().route('/x/web-interface/nav', { json: NAV_JSON })
    const { db, repo, wbi } = buildWbi(fake)
    const keys = await wbi.get()

    expect(keys.imgKey).toBe(REAL_IMG_KEY)
    expect(keys.mixinKey).toBe(REAL_MIXIN_KEY)
    expect(repo.get()?.imgKey).toBe(REAL_IMG_KEY)
    expect(fake.calls).toHaveLength(1)
    db.close()
  })

  it('同一天内复用缓存，不重复请求 nav', async () => {
    const fake = new FakeFetch().route('/x/web-interface/nav', { json: NAV_JSON })
    const { db, wbi, clock } = buildWbi(fake)
    await wbi.get()
    clock.advance(60 * 60 * 1000) // 1 小时后仍是同一天
    await wbi.get()
    expect(fake.calls).toHaveLength(1)
    db.close()
  })

  it('跨自然日自动重取（wts 的 key 必须与当天一致）', async () => {
    // 第一条路由只用一次，之后的请求落到下面新注册的路由（FakeFetch 按注册顺序匹配）
    const fake = new FakeFetch().route('/x/web-interface/nav', { json: NAV_JSON }, 1)
    const { db, wbi, clock } = buildWbi(fake)
    await wbi.get()
    const next: string = NEXT_DAY_IMG_KEY
    fake.route('/x/web-interface/nav', {
      json: {
        ...NAV_JSON,
        data: { isLogin: false, wbi_img: { img_url: `https://i0.hdslb.com/bfs/wbi/${next}.png`, sub_url: `https://i0.hdslb.com/bfs/wbi/${REAL_SUB_KEY}.png` } },
      },
    })
    clock.advance(25 * 60 * 60 * 1000)
    const keys = await wbi.get()
    expect(keys.imgKey).toBe(next)
    expect(fake.calls.length).toBeGreaterThanOrEqual(2)
    db.close()
  })

  it('nav 失败但当天已有缓存时降级复用（只 warn，不抛）', async () => {
    const fake = new FakeFetch().route('/x/web-interface/nav', { json: NAV_JSON }, 1)
    const { db, wbi, clock } = buildWbi(fake)
    await wbi.get()

    // 第二天 nav 开始报错（网络抖动），仍应返回昨天的 key 而不是让解析直接失败
    fake.route('/x/web-interface/nav', { status: 500, text: 'oops' }, 5)
    clock.advance(25 * 60 * 60 * 1000)
    const keys = await wbi.get()
    expect(keys.imgKey).toBe(REAL_IMG_KEY)
    db.close()
  })

  it('nav 响应缺少 wbi_img 时明确失败（不静默）', async () => {
    const fake = new FakeFetch().route('/x/web-interface/nav', {
      json: { code: 0, data: { isLogin: false } },
    })
    const { db, wbi } = buildWbi(fake)
    await expect(wbi.get()).rejects.toMatchObject({ code: 'WBI_KEY_MISSING' })
    db.close()
  })
})

const NEXT_DAY_IMG_KEY = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
