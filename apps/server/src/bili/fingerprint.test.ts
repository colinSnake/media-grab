import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { BiliRateLimiter } from '../lib/token-bucket.js'
import { Database } from '../store/db.js'
import { DeviceRepository } from '../store/repositories.js'
import { FakeFetch } from '../testing/fake-fetch.js'
import { FingerprintService, readSetCookie } from './fingerprint.js'
import { BiliHttp } from './http.js'
import { BiliTicketService } from './ticket.js'

const BUVID3 = 'FD9CDD64-6989-934F-6066-9C59639D10CA75158infoc'
const BUVID4 = 'B8DAB8A2-F563-EE1E-8057-349FABA22BD975158-026101616'
const B_NUT = 1_792_139_575
const TICKET = 'eyJhbGciOiJIUzI1NiIsImtpZCI6InMwMyJ9.payload.signature'

const SPI_JSON = { code: 0, message: 'ok', data: { b_3: BUVID3, b_4: BUVID4 } }
const TICKET_JSON = {
  code: 0,
  message: 'OK',
  data: { ticket: TICKET, created_at: 1_792_139_575, ttl: 259_200 },
}

function buildFake(): FakeFetch {
  return new FakeFetch()
    .route('/x/frontend/finger/spi', { json: SPI_JSON })
    .route('https://www.bilibili.com/', {
      text: '<!doctype html><html></html>',
      setCookies: ['buvid3=WEB-BUVID3; Path=/', `b_nut=${B_NUT}; Path=/`],
    })
    .route('/GenWebTicket', { json: TICKET_JSON })
}

function build(fake: FakeFetch, localNow: () => number = () => (TICKET_JSON.data.created_at + 60) * 1000) {
  const db = Database.open(':memory:')
  const repo = new DeviceRepository(db)
  const http = new BiliHttp({
    fetchImpl: fake.fetchImpl,
    limiter: new BiliRateLimiter({ apiMinIntervalMs: 0, passportMinIntervalMs: 0 }),
    sleep: async () => {},
    localNow,
  })
  const ticket = new BiliTicketService({ http, repo })
  const fingerprint = new FingerprintService({ http, repo, ticket })
  return { db, repo, http, ticket, fingerprint }
}

function countCalls(fake: FakeFetch, fragment: string): number {
  return fake.calls.filter((call) => call.url.includes(fragment)).length
}

describe('设备指纹：免登硬要求（RISK §3.1/3.2）', () => {
  it('首次启动取 buvid3/buvid4/b_nut 并落盘', async () => {
    const fake = buildFake()
    const { db, repo, fingerprint } = build(fake)

    const result = await fingerprint.initialize()
    expect(result.fingerprint).toEqual({ buvid3: BUVID3, buvid4: BUVID4, bNut: B_NUT })
    expect(result.source).toBe('network')
    expect(result.bNutSource).toBe('cookie')
    expect(result.ticket.available).toBe(true)

    const stored = repo.get()
    expect(stored?.buvid3).toBe(BUVID3)
    expect(stored?.buvid4).toBe(BUVID4)
    expect(stored?.bNut).toBe(B_NUT)
    expect(stored?.biliTicket).toBe(TICKET)
    db.close()
  })

  it('重启后复用落盘指纹，不再请求 spi（设备身份必须稳定）', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'mediaGrab-fp-'))
    const file = path.join(dir, 'device.db')
    const fake = buildFake()

    try {
      // 第一次启动：真实文件库，取指纹并落盘
      const db1 = Database.open(file)
      const repo1 = new DeviceRepository(db1)
      const http1 = new BiliHttp({
        fetchImpl: fake.fetchImpl,
        limiter: new BiliRateLimiter({ apiMinIntervalMs: 0, passportMinIntervalMs: 0 }),
        sleep: async () => {},
      })
      const fp1 = new FingerprintService({ http: http1, repo: repo1 })
      await fp1.initialize()
      expect(countCalls(fake, '/finger/spi')).toBe(1)
      db1.close()

      // 第二次启动：重开库，指纹必须原样复用
      const db2 = Database.open(file)
      const repo2 = new DeviceRepository(db2)
      const fp2 = new FingerprintService({ http: http1, repo: repo2 })
      expect(fp2.load()).toEqual({ buvid3: BUVID3, buvid4: BUVID4, bNut: B_NUT })
      expect(await fp2.ensure()).toEqual({ buvid3: BUVID3, buvid4: BUVID4, bNut: B_NUT })
      expect(countCalls(fake, '/finger/spi')).toBe(1)
      db2.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('Cookie 头按 buvid3 + buvid4 + b_nut 组装，票据未过期时附带', async () => {
    const fake = buildFake()
    const { db, fingerprint } = build(fake)
    await fingerprint.initialize()

    const cookie = fingerprint.cookieHeader()
    expect(cookie).toContain(`buvid3=${BUVID3}`)
    expect(cookie).toContain(`buvid4=${BUVID4}`)
    expect(cookie).toContain(`b_nut=${B_NUT}`)
    expect(cookie).toContain(`bili_ticket=${TICKET}`)
    db.close()
  })

  it('指纹未就绪时 Cookie 为空（自举阶段就是裸请求）', () => {
    const fake = buildFake()
    const { db, fingerprint } = build(fake)
    expect(fingerprint.cookieHeader()).toBe('')
    db.close()
  })

  it('b_nut 取不到时回退当前时间戳，不影响指纹可用', async () => {
    const fake = new FakeFetch()
      .route('/x/frontend/finger/spi', { json: SPI_JSON })
      .route('https://www.bilibili.com/', { status: 500, text: 'oops' })
      .route('/GenWebTicket', { json: TICKET_JSON })
    const { db, repo, fingerprint } = build(fake)

    const result = await fingerprint.initialize()
    expect(result.bNutSource).toBe('fallback')
    expect(result.fingerprint.bNut).toBeGreaterThan(0)
    expect(repo.get()?.bNut).toBe(result.fingerprint.bNut)
    db.close()
  })

  it('bili_ticket 获取失败不阻塞链路（增强项）', async () => {
    const fake = new FakeFetch()
      .route('/x/frontend/finger/spi', { json: SPI_JSON })
      .route('https://www.bilibili.com/', { text: 'x', setCookies: [`b_nut=${B_NUT}`] })
      .route('/GenWebTicket', { status: 404, text: 'not found' })
    const { db, repo, fingerprint } = build(fake)

    const result = await fingerprint.initialize()
    expect(result.ticket.available).toBe(false)
    expect(result.ticket.reason).toBeDefined()
    expect(repo.get()?.biliTicket).toBeNull()
    // 指纹本身仍然可用
    expect(repo.get()?.buvid3).toBe(BUVID3)
    expect(fingerprint.cookieHeader()).toContain('buvid3=')
    db.close()
  })

  it('指纹接口没返回 buvid 时明确失败（不伪造）', async () => {
    const fake = new FakeFetch().route('/x/frontend/finger/spi', {
      json: { code: 0, message: 'ok', data: { b_3: '', b_4: '' } },
    })
    const { db, fingerprint } = build(fake)
    await expect(fingerprint.ensure()).rejects.toMatchObject({ code: 'FINGERPRINT_FAILED' })
    db.close()
  })

  it('readSetCookie 只认精确名字，不误吞前缀相近的 cookie', () => {
    expect(readSetCookie(['b_nut=1; Path=/'], 'b_nut')).toBe('1')
    expect(readSetCookie(['b_nut_x=9; Path=/'], 'b_nut')).toBeUndefined()
    expect(readSetCookie([], 'b_nut')).toBeUndefined()
  })
})

describe('bili_ticket：免登可得（M1-9 实测结论）', () => {
  it('用 HMAC-SHA256 签名并带上 context[ts]，成功后在有效期内复用', async () => {
    const fake = buildFake()
    const fixtureNow = (TICKET_JSON.data.created_at + 60) * 1000
    const { db, http, repo } = build(fake, () => fixtureNow)
    const ticket = new BiliTicketService({ http, repo })

    const first = await ticket.ensure()
    expect(first.refreshed).toBe(true)
    expect(first.ticket).toBe(TICKET)

    const second = await ticket.ensure()
    expect(second.refreshed).toBe(false)
    expect(countCalls(fake, 'GenWebTicket')).toBe(1)

    const call = fake.calls.find((item) => item.url.includes('GenWebTicket'))
    expect(call?.method).toBe('POST')
    expect(call?.url).toContain('key_id=ec02')
    expect(call?.url).toContain('hexsign=')
    expect(call?.url).toContain('context%5Bts%5D=')
    expect(call?.url).toContain('csrf=')
    db.close()
  })

  it('临近过期会提前刷新', async () => {
    const fake = buildFake()
    const { db, http, repo } = build(fake)
    const ticket = new BiliTicketService({ http, repo, refreshBeforeSec: 259_200 })
    await ticket.ensure()
    const again = await ticket.ensure()
    expect(again.refreshed).toBe(true)
    expect(countCalls(fake, 'GenWebTicket')).toBe(2)
    db.close()
  })
})
