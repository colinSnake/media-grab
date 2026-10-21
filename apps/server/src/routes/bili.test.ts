import path from 'node:path'
import { tmpdir } from 'node:os'
import {
  defaultAppConfig,
  healthResponseSchema,
  parseResultSchema,
  playurlResultSchema,
} from '@mediagrab/shared'
import type { FastifyInstance } from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildApp } from '../app.js'
import { BiliRateLimiter } from '../lib/token-bucket.js'
import { createServices, type Services } from '../services.js'
import { FakeFetch } from '../testing/fake-fetch.js'

/**
 * 路由层验收：**零凭据**环境下的免登链路（ADR-1 / 风控清单第 1、2 项）。
 *
 * 全程用假 fetch，不触网；断言的重点是"输出是否如实"：
 * 档位可用性必须来自 `dash.video[].id`，且库里不能出现任何账号凭据。
 */

const BVID = 'BV1GJ411x7h7'
const CID = 137649199
const IMG_KEY = '7cd084941338484aae1ad9425b84077c'
const SUB_KEY = '4932caff0ff746eab6f01bf08b70ac45'

const SPI_JSON = {
  code: 0,
  message: 'ok',
  data: { b_3: 'FD9CDD64-6989-934F-6066-9C59639D10CA75158infoc', b_4: 'B8DAB8A2-F563-EE1E' },
}

const NAV_JSON = {
  code: -101,
  message: '账号未登录',
  data: {
    isLogin: false,
    wbi_img: {
      img_url: `https://i0.hdslb.com/bfs/wbi/${IMG_KEY}.png`,
      sub_url: `https://i0.hdslb.com/bfs/wbi/${SUB_KEY}.png`,
    },
  },
}

const TICKET_JSON = {
  code: 0,
  message: 'OK',
  data: { ticket: 'eyJhbGciOiJIUzI1NiJ9.payload.sig', created_at: 1_792_139_575, ttl: 259_200 },
}

const VIEW_JSON = {
  code: 0,
  message: '0',
  data: {
    bvid: BVID,
    aid: 170001,
    cid: CID,
    title: '【官方 MV】Never Gonna Give You Up - Rick Astley',
    pic: 'https://i0.hdslb.com/cover.jpg',
    duration: 213,
    owner: { mid: 777, name: 'Rick Astley' },
    pages: [{ cid: CID, page: 1, part: 'Never Gonna Give You Up', duration: 213 }],
  },
}

/** 实测基线：声明 5 档，实际只交付 360P/480P */
const PLAYURL_JSON = {
  code: 0,
  message: '0',
  data: {
    quality: 64,
    accept_quality: [112, 80, 64, 32, 16],
    accept_description: ['1080P+', '1080P', '720P', '480P', '360P'],
    dash: {
      duration: 213,
      video: [
        { id: 32, base_url: 'https://cdn.example.com/480-avc.m4s', codecid: 7, width: 852, height: 480 },
        { id: 16, base_url: 'https://cdn.example.com/360-hevc.m4s', codecid: 12, width: 640, height: 360 },
      ],
      audio: [
        { id: 30280, base_url: 'https://cdn.example.com/192.m4s' },
        { id: 30232, base_url: 'https://cdn.example.com/132.m4s' },
      ],
    },
  },
}

function buildFake(): FakeFetch {
  return new FakeFetch()
    .route('/x/frontend/finger/spi', { json: SPI_JSON })
    .route('https://www.bilibili.com/', {
      text: '<!doctype html><html></html>',
      setCookies: ['buvid3=WEB; Path=/', 'b_nut=1792139575; Path=/'],
    })
    .route('/GenWebTicket', { json: TICKET_JSON })
    .route('/x/web-interface/nav', { json: NAV_JSON })
    .route('/x/web-interface/view', { json: VIEW_JSON })
    .route('/x/player/wbi/playurl', { json: PLAYURL_JSON })
}

let app: FastifyInstance | undefined
let services: Services | undefined

async function setup(fake = buildFake()): Promise<{ app: FastifyInstance; services: Services; fake: FakeFetch }> {
  services = createServices({
    config: defaultAppConfig(),
    dbPath: ':memory:',
    fetchImpl: fake.fetchImpl,
    sleep: async () => {},
    now: () => (TICKET_JSON.data.created_at + 60) * 1000,
    limiter: new BiliRateLimiter({ apiMinIntervalMs: 0, passportMinIntervalMs: 0 }),
  })
  app = await buildApp({
    config: services.config.get(),
    services,
    // 指向一个不存在的目录：走"前端未构建"分支，不影响 API 断言
    webDist: path.join(tmpdir(), 'mediaGrab-no-web-dist'),
    logger: false,
  })
  return { app, services, fake }
}

afterEach(async () => {
  await app?.close()
  app = undefined
  services = undefined
})

describe('POST /api/parse：零凭据解析（风控清单第 1 项）', () => {
  it('无任何凭据即可解析，档位如实反映"匿名实际可得"范围', async () => {
    const { app: instance, services: svc, fake } = await setup()
    // 先做一次免登初始化（指纹 + 票据），模拟真实启动
    await svc.bili.initialize()

    const response = await instance.inject({
      method: 'POST',
      url: '/api/parse',
      payload: { input: BVID },
    })
    expect(response.statusCode).toBe(200)

    const parsed = parseResultSchema.safeParse(response.json())
    expect(parsed.success).toBe(true)
    const body = parsed.success ? parsed.data : undefined
    expect(body?.bvid).toBe(BVID)
    expect(body?.cid).toBe(CID)
    expect(body?.title).toContain('Never Gonna Give You Up')
    expect(body?.ownerName).toBe('Rick Astley')
    expect(body?.cover).toBe('https://i0.hdslb.com/cover.jpg')
    expect(body?.pages).toHaveLength(1)
    expect(body?.session).toEqual({ loggedIn: false, vip: false })

    const byQn = new Map(body?.qualities.map((item) => [item.qn, item]))
    expect(body?.qualities.filter((item) => item.available).map((item) => item.qn)).toEqual([32, 16])
    expect(byQn.get(64)?.state).toBe('need-login')
    expect(byQn.get(112)?.state).toBe('need-vip')

    // 档位可用性以实际交付为准（清单第 2 项）：代码里绝不拿 accept_quality 决定可点性
    expect(body?.qualities.find((item) => item.qn === 80)?.available).toBe(false)

    // 取流请求确实带了 WBI 签名
    const playurlCall = fake.calls.find((call) => call.url.includes('/x/player/wbi/playurl'))
    expect(playurlCall?.url).toContain('w_rid=')
    expect(playurlCall?.url).toContain('wts=')

    // 零凭据：库里不应出现任何账号凭据字段
    const dump = JSON.stringify({
      device: svc.db.prepare('SELECT * FROM device').all(),
      settings: svc.db.prepare('SELECT * FROM settings').all(),
      wbi: svc.db.prepare('SELECT * FROM wbi_keys').all(),
    })
    expect(dump).not.toContain('SESSDATA')
    expect(dump).not.toContain('bili_jct')
    expect(dump).toContain('buvid3') // 指纹是必须落盘的
  })

  it('支持 av 号 / 完整 URL / b23.tv 短链（FR-01）', async () => {
    const fake = buildFake().route(
      'https://b23.tv/',
      { status: 302, text: '', headers: { location: `https://www.bilibili.com/video/${BVID}` } },
    )
    const { app: instance } = await setup(fake)

    for (const input of [
      'av170001',
      `https://www.bilibili.com/video/${BVID}/?p=1`,
      'https://b23.tv/abc123',
    ]) {
      const response = await instance.inject({ method: 'POST', url: '/api/parse', payload: { input } })
      expect(response.statusCode, `输入 ${input} 应能解析`).toBe(200)
      expect(response.json<{ bvid: string }>().bvid).toBe(BVID)
    }
  })

  it('非法输入给出明确文案（400 / invalid）', async () => {
    const { app: instance } = await setup()
    const response = await instance.inject({
      method: 'POST',
      url: '/api/parse',
      payload: { input: '这不是链接' },
    })
    expect(response.statusCode).toBe(400)
    expect(response.json()).toMatchObject({ error: { kind: 'invalid' } })
    expect(response.json<{ error: { message: string } }>().error.message.length).toBeGreaterThan(0)
  })

  it('不存在的分P 返回 404，而不是静默用第 1 P', async () => {
    const { app: instance } = await setup()
    const response = await instance.inject({
      method: 'POST',
      url: '/api/parse',
      payload: { input: BVID, page: 9 },
    })
    expect(response.statusCode).toBe(404)
    expect(response.json<{ error: { message: string } }>().error.message).toContain('分P')
  })
})

describe('POST /api/playurl：候选流与可用性', () => {
  it('返回候选流、编码信息与可用性（M2 直接复用）', async () => {
    const { app: instance } = await setup()
    const response = await instance.inject({
      method: 'POST',
      url: '/api/playurl',
      payload: { bvid: BVID, cid: CID },
    })
    expect(response.statusCode).toBe(200)

    const parsed = playurlResultSchema.safeParse(response.json())
    expect(parsed.success).toBe(true)
    const body = parsed.success ? parsed.data : undefined
    expect(body?.video.map((item) => item.id)).toEqual([32, 16])
    expect(body?.audio.map((item) => item.id)).toEqual([30280, 30232])
    expect(body?.urlTtlSec).toBe(7_200)
    expect(body?.qualities.filter((item) => item.available).map((item) => item.qn)).toEqual([32, 16])
  })

  it('cid 非法时 400', async () => {
    const { app: instance } = await setup()
    const response = await instance.inject({
      method: 'POST',
      url: '/api/playurl',
      payload: { bvid: BVID, cid: -1 },
    })
    expect(response.statusCode).toBe(400)
    expect(response.json()).toMatchObject({ error: { code: 'INVALID_INPUT' } })
  })
})

describe('免登相关的只读接口', () => {
  it('GET /api/session 如实返回匿名态与指纹摘要（不下发凭据）', async () => {
    const { app: instance, services: svc } = await setup()
    await svc.bili.initialize()

    const response = await instance.inject({ method: 'GET', url: '/api/session' })
    expect(response.statusCode).toBe(200)
    const body = response.json<{
      loggedIn: boolean
      vip: boolean
      anonymous: boolean
      loginAvailable: boolean
      account: null
      device: { fingerprintReady: boolean; buvid3Prefix: string; ticketAvailable: boolean }
    }>()
    expect(body).toMatchObject({
      loggedIn: false,
      vip: false,
      anonymous: true,
      loginAvailable: true,
      account: null,
      device: { fingerprintReady: true, ticketAvailable: true },
    })
    expect(body.device.buvid3Prefix).toHaveLength(4)
    expect(response.body).not.toContain('buvid3=')
  })

  it('GET /api/health 反映指纹 / WBI / 数据库 / 限速状态', async () => {
    const { app: instance, services: svc } = await setup()
    await svc.bili.initialize()
    // 触发一次 WBI key 获取
    await instance.inject({ method: 'POST', url: '/api/playurl', payload: { bvid: BVID, cid: CID } })

    const response = await instance.inject({ method: 'GET', url: '/api/health' })
    expect(response.statusCode).toBe(200)

    // 与 shared 的 schema 对齐（字段漂移会在这里暴露，而不是等前端崩）
    const parsed = healthResponseSchema.safeParse(response.json())
    expect(parsed.success, JSON.stringify(parsed.success ? {} : parsed.error.issues)).toBe(true)
    const body = parsed.success ? parsed.data : undefined
    expect(body?.ok).toBe(true)
    expect(body?.session.anonymous).toBe(true)
    expect(body?.bili.db).toMatchObject({ path: ':memory:', ok: true })
    expect(body?.bili.device.present).toBe(true)
    expect(body?.bili.device.ticket.available).toBe(true)
    expect(body?.bili.wbi?.sameDay).toBe(true)
    expect(body?.bili.rateLimit.playurl.limit).toBe(2)
    // 指纹与 key 只下发摘要，不带明文
    expect(body?.bili.wbi?.imgKey).toBe(`${IMG_KEY.slice(0, 4)}********`)
    expect(response.body).not.toContain(IMG_KEY)
  })

  it('未定义接口返回统一错误信封（不是 HTML）', async () => {
    const { app: instance } = await setup()
    const response = await instance.inject({ method: 'GET', url: '/api/nope' })
    expect(response.statusCode).toBe(404)
    expect(response.json()).toMatchObject({ error: { code: 'NOT_FOUND', kind: 'notFound' } })
  })
})

describe('配置落库（M1-6 / NFR-10）', () => {
  it('PATCH /api/config 生效并写入 settings 表', async () => {
    const { app: instance, services: svc } = await setup()
    const patched = await instance.inject({
      method: 'PATCH',
      url: '/api/config',
      payload: { savePath: '/tmp/mediaGrab-test', downloadPoolSize: 5 },
    })
    expect(patched.statusCode).toBe(200)

    const stored = svc.settings.get('savePath')
    expect(stored).toBe('"/tmp/mediaGrab-test"')
    const read = await instance.inject({ method: 'GET', url: '/api/config' })
    expect(read.json<{ savePath: string; downloadPoolSize: number }>()).toMatchObject({
      savePath: '/tmp/mediaGrab-test',
      downloadPoolSize: 5,
    })
  })

  it('PATCH /api/config 后立即通知下载队列重新调度', async () => {
    const { app: instance, services: svc } = await setup()
    const configChanged = vi.spyOn(svc.downloads, 'configChanged')
    const patched = await instance.inject({
      method: 'PATCH',
      url: '/api/config',
      payload: { downloadPoolSize: 4 },
    })

    expect(patched.statusCode).toBe(200)
    expect(configChanged).toHaveBeenCalledOnce()
  })

  it('未知配置项被明确拒绝，不允许"改了没反应"', async () => {
    const { app: instance } = await setup()
    const response = await instance.inject({
      method: 'PATCH',
      url: '/api/config',
      payload: { notARealOption: 1 },
    })
    expect(response.statusCode).toBe(400)
    expect(response.json()).toMatchObject({ error: { code: 'UNKNOWN_CONFIG_FIELD' } })
  })
})

describe('抖音 Cookie API', () => {
  it('只返回是否已配置，不在响应中回显 Cookie', async () => {
    const { app: instance } = await setup()
    const saved = await instance.inject({
      method: 'POST',
      url: '/api/accounts/douyin/cookie',
      payload: { cookie: 'sessionid=do-not-return-this' },
    })
    expect(saved.statusCode).toBe(200)
    expect(saved.json()).toEqual({ configured: true })
    expect(saved.body).not.toContain('do-not-return-this')

    const status = await instance.inject({ method: 'GET', url: '/api/accounts/douyin/cookie' })
    expect(status.json()).toEqual({ configured: true })

    const cleared = await instance.inject({ method: 'DELETE', url: '/api/accounts/douyin/cookie' })
    expect(cleared.json()).toEqual({ configured: false })
  })

  it('小红书 Cookie API 仅回传配置状态', async () => {
    const { app: instance } = await setup()
    const saved = await instance.inject({
      method: 'POST',
      url: '/api/accounts/xiaohongshu/cookie',
      payload: { cookie: 'web_session=do-not-return-this' },
    })
    expect(saved.statusCode).toBe(200)
    expect(saved.json()).toEqual({ configured: true })
    expect(saved.body).not.toContain('do-not-return-this')
    const cleared = await instance.inject({ method: 'DELETE', url: '/api/accounts/xiaohongshu/cookie' })
    expect(cleared.json()).toEqual({ configured: false })
  })
})
