import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { ApiError } from '../lib/errors.js'
import type { Logger } from '../lib/logger.js'
import { INTERACTIVE_RETRY } from '../lib/retry.js'
import { BiliRateLimiter } from '../lib/token-bucket.js'
import { FakeFetch, makeFakeClock } from '../testing/fake-fetch.js'
import {
  BiliHttp,
  DEFAULT_USER_AGENT,
  SEC_CH_UA,
  SEC_CH_UA_PLATFORM,
  UA_MAJOR,
  looksLikeRiskPage,
  type BiliHttpOptions,
} from './http.js'

const envelope = z.object({
  code: z.number(),
  message: z.string().optional(),
  data: z.object({ ok: z.boolean().default(true) }).optional(),
})

const OK_JSON = { code: 0, message: '0', data: { ok: true } }
const ONE_ATTEMPT = { ...INTERACTIVE_RETRY, maxAttempts: 1 }
const URL_ = 'https://api.bilibili.com/x/test'

interface Harness {
  http: BiliHttp
  fake: FakeFetch
  clock: ReturnType<typeof makeFakeClock>
  logs: Array<{ obj: unknown; msg?: string }>
  logger: Logger
}

function harness(
  fake = new FakeFetch(),
  overrides: Partial<BiliHttpOptions> = {},
): Harness {
  const clock = makeFakeClock()
  const logs: Array<{ obj: unknown; msg?: string }> = []
  const logger: Logger = {
    debug: (obj, msg) => logs.push({ obj, msg }),
    info: (obj, msg) => logs.push({ obj, msg }),
    warn: (obj, msg) => logs.push({ obj, msg }),
    error: (obj, msg) => logs.push({ obj, msg }),
  }
  const http = new BiliHttp({
    fetchImpl: fake.fetchImpl,
    limiter: new BiliRateLimiter({ apiMinIntervalMs: 0, passportMinIntervalMs: 0 }),
    sleep: clock.sleep,
    localNow: clock.now,
    logger,
    defaultRetryPolicy: ONE_ATTEMPT,
    // 抖动固定：断言退避序列时只看策略，不看随机数
    random: () => 0.5,
    ...overrides,
  })
  return { http, fake, clock, logs, logger }
}

describe('请求头基线（RISK §7：一致 > 随机）', () => {
  it('UA 与 sec-ch-ua 版本号一致，平台一致', () => {
    expect(DEFAULT_USER_AGENT).toContain(`Chrome/${UA_MAJOR}`)
    expect(SEC_CH_UA).toContain(`v="${UA_MAJOR}"`)
    expect(DEFAULT_USER_AGENT).toContain('Macintosh')
    expect(SEC_CH_UA_PLATFORM).toBe('macOS')
  })

  it('api 语义：same-site + 跨源必带 Origin（实测 same-origin/缺 Origin 会被 412）', async () => {
    const fake = new FakeFetch().route('/x/test', { json: OK_JSON })
    const { http } = harness(fake)
    await http.json(envelope, URL_)

    const headers = fake.calls[0]?.headers ?? {}
    expect(headers['user-agent']).toBe(DEFAULT_USER_AGENT)
    expect(headers['referer']).toBe('https://www.bilibili.com/')
    expect(headers['sec-fetch-mode']).toBe('cors')
    expect(headers['sec-fetch-dest']).toBe('empty')
    // www.bilibili.com → api.bilibili.com 是同站跨源：Site=same-site，且 GET 也要带 Origin
    expect(headers['sec-fetch-site']).toBe('same-site')
    expect(headers['origin']).toBe('https://www.bilibili.com')
    expect(headers['sec-ch-ua-platform']).toBe(`"${SEC_CH_UA_PLATFORM}"`)
    expect(headers['cookie']).toBeUndefined()
  })

  it('同源请求不带 Origin（浏览器语义）', async () => {
    const fake = new FakeFetch().route('/x/test', { json: OK_JSON })
    const { http } = harness(fake)
    await http.json(envelope, URL_, { referer: 'https://api.bilibili.com/some/page' })
    const headers = fake.calls[0]?.headers ?? {}
    expect(headers['sec-fetch-site']).toBe('same-site')
    expect(headers['origin']).toBeUndefined()
  })

  it('document 语义切换 Sec-Fetch-* 且不带 Origin（首页导航不能伪装成 XHR）', async () => {
    const fake = new FakeFetch().route('/x/test', { json: OK_JSON })
    const { http } = harness(fake)
    await http.json(envelope, URL_, { semantics: 'document' })
    const headers = fake.calls[0]?.headers ?? {}
    expect(headers['sec-fetch-dest']).toBe('document')
    expect(headers['sec-fetch-mode']).toBe('navigate')
    expect(headers['sec-fetch-site']).toBe('none')
    expect(headers['origin']).toBeUndefined()
  })

  it('Cookie 由 provider 注入；cookie:none 明确不带（指纹自举）', async () => {
    const fake = new FakeFetch().route('/x/test', { json: OK_JSON })
    const { http } = harness(fake)
    http.setCookieProvider(() => 'buvid3=AAA; buvid4=BBB; b_nut=1')

    await http.json(envelope, URL_)
    expect(fake.calls[0]?.headers['cookie']).toBe('buvid3=AAA; buvid4=BBB; b_nut=1')

    await http.json(envelope, URL_, { cookie: 'none' })
    expect(fake.calls[1]?.headers['cookie']).toBeUndefined()
  })

  it('POST 带 Origin 与表单体', async () => {
    const fake = new FakeFetch().route('/x/test', { json: OK_JSON })
    const { http } = harness(fake)
    await http.json(envelope, URL_, { method: 'POST', form: { a: 1, b: 'x' }, referer: 'https://www.bilibili.com/' })

    const call = fake.calls[0]
    expect(call?.method).toBe('POST')
    expect(call?.headers['origin']).toBe('https://www.bilibili.com')
    expect(call?.headers['content-type']).toBe('application/x-www-form-urlencoded')
    expect(call?.body).toBe('a=1&b=x')
  })

  it('query 里 undefined 被跳过，布尔转 1/0', async () => {
    const fake = new FakeFetch().route('/x/test', { json: OK_JSON })
    const { http } = harness(fake)
    await http.json(envelope, URL_, { query: { a: 1, b: undefined, c: true, d: false } })
    const url = new URL(fake.calls[0]?.url ?? '')
    expect(url.searchParams.get('a')).toBe('1')
    expect(url.searchParams.has('b')).toBe(false)
    expect(url.searchParams.get('c')).toBe('1')
    expect(url.searchParams.get('d')).toBe('0')
  })
})

describe('时钟与错误分类', () => {
  it('用响应 Date 头校正时钟偏差', async () => {
    const fake = new FakeFetch().route('/x/test', {
      json: OK_JSON,
      headers: { date: new Date(1_700_000_010_000).toUTCString() },
    })
    const { http, clock } = harness(fake)
    clock.advance(0)
    await http.json(envelope, URL_)
    // 假时钟起点 1_700_000_000_000，Date 头为 +10s（HTTP Date 秒级精度）
    expect(http.clock.offsetMs).toBe(10_000)
  })

  it('B站业务码决定分类：-412 → risk 可重试，-101 → auth 不可重试', async () => {
    const riskFake = new FakeFetch().route('/x/test', { json: { code: -412, message: '风控' } })
    await expect(harness(riskFake).http.json(envelope, URL_)).rejects.toMatchObject({
      kind: 'risk',
      retryable: true,
      biliCode: -412,
    })

    const authFake = new FakeFetch().route('/x/test', { json: { code: -101, message: '未登录' } })
    await expect(harness(authFake).http.json(envelope, URL_)).rejects.toMatchObject({
      kind: 'auth',
      retryable: false,
      biliCode: -101,
    })
  })

  it('acceptCodes 放行 -101（匿名 nav 的真实行为）', async () => {
    const fake = new FakeFetch().route('/x/test', { json: { code: -101, message: '账号未登录', data: { ok: true } } })
    const { http } = harness(fake)
    const response = await http.json(envelope, URL_, { acceptCodes: [0, -101] })
    expect(response.code).toBe(-101)
    expect(response.envelope.data?.ok).toBe(true)
  })

  it('HTTP 5xx 归为 network（可重试），风控页归为 risk', async () => {
    const five = new FakeFetch().route('/x/test', { status: 503, text: 'busy' })
    await expect(harness(five).http.json(envelope, URL_)).rejects.toMatchObject({ kind: 'network' })

    const riskPage = new FakeFetch().route('/x/test', { status: 200, text: '<html>出错啦! 请求过于频繁</html>' })
    await expect(harness(riskPage).http.json(envelope, URL_)).rejects.toMatchObject({ kind: 'risk' })
  })

  it('响应结构不符时明确失败（fatal，不重试）', async () => {
    const fake = new FakeFetch().route('/x/test', { json: { code: 0, data: { ok: 'not-boolean' } } })
    await expect(harness(fake).http.json(envelope, URL_)).rejects.toMatchObject({
      code: 'UNEXPECTED_RESPONSE',
      kind: 'fatal',
    })
  })

  it('looksLikeRiskPage 只认风控特征', () => {
    expect(looksLikeRiskPage('<title>出错啦! - bilibili.com</title>')).toBe(true)
    expect(looksLikeRiskPage('{"code":0}')).toBe(false)
  })
})

describe('重试与取消', () => {
  it('风控失败按交互策略退避后重试成功', async () => {
    let calls = 0
    const fake = new FakeFetch().route('/x/test', () => {
      calls += 1
      return calls < 2 ? { json: { code: -412, message: '风控' } } : { json: OK_JSON }
    })
    const { http, clock } = harness(fake, { defaultRetryPolicy: INTERACTIVE_RETRY })
    const response = await http.json(envelope, URL_)
    expect(response.code).toBe(0)
    expect(calls).toBe(2)
    expect(clock.sleeps).toEqual([2_000])
  })

  it('超时给出 TIMEOUT（network 类）', async () => {
    const hanging = ((_input: unknown, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal
        if (signal?.aborted) {
          reject(signal.reason)
          return
        }
        signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
      })) as unknown as typeof fetch

    const http = new BiliHttp({
      fetchImpl: hanging,
      limiter: new BiliRateLimiter({ apiMinIntervalMs: 0 }),
      defaultRetryPolicy: ONE_ATTEMPT,
      defaultTimeoutMs: 20,
    })
    await expect(http.json(envelope, URL_)).rejects.toMatchObject({ code: 'TIMEOUT', kind: 'network' })
  })

  it('调用方取消给出 CANCELLED，不再重试', async () => {
    const hanging = ((_input: unknown, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
      })) as unknown as typeof fetch

    const http = new BiliHttp({
      fetchImpl: hanging,
      limiter: new BiliRateLimiter({ apiMinIntervalMs: 0 }),
      defaultRetryPolicy: INTERACTIVE_RETRY,
    })
    const controller = new AbortController()
    const pending = http.json(envelope, URL_, { signal: controller.signal })
    controller.abort()
    await expect(pending).rejects.toMatchObject({ code: 'CANCELLED', kind: 'invalid' })
  })
})

describe('日志脱敏（红线）', () => {
  it('日志里不出现 SESSDATA 明文', async () => {
    const fake = new FakeFetch().route('/x/test', { json: { code: -412, message: '风控' } })
    const { http, logs } = harness(fake, { defaultRetryPolicy: INTERACTIVE_RETRY })
    http.setCookieProvider(() => 'SESSDATA=supersecretvalue; buvid3=BUVID3PLAINTEXT')
    await expect(http.json(envelope, URL_)).rejects.toBeInstanceOf(ApiError)

    const dump = JSON.stringify(logs)
    expect(dump).not.toContain('supersecretvalue')
    expect(dump).not.toContain('BUVID3PLAINTEXT')
    expect(dump).toContain('SESSDATA=')
  })
})
