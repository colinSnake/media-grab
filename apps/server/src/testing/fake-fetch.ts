/**
 * 测试用假 fetch（不打真实网络 —— NFR/G6 的硬要求）。
 *
 * 只实现本项目用到的部分：按 URL 匹配、返回 JSON 或文本、可设置响应头与 Set-Cookie、
 * 记录调用（断言限速/重试行为要靠它）。
 */

export interface FakeCall {
  url: string
  method: string
  body: string | undefined
  headers: Record<string, string>
}

export interface FakeReply {
  status?: number
  /** 返回 JSON（自动加 content-type） */
  json?: unknown
  /** 返回文本（与 json 二选一） */
  text?: string
  headers?: Record<string, string>
  /** Set-Cookie 头（可多条） */
  setCookies?: string[]
}

type Matcher = string | RegExp | ((url: URL) => boolean)
type ReplyFactory = (url: URL, call: FakeCall, index: number) => FakeReply

interface Route {
  match: Matcher
  reply: FakeReply | ReplyFactory
  /** 剩余可用次数；undefined 表示无限 */
  remaining?: number
}

function matches(matcher: Matcher, url: URL): boolean {
  if (typeof matcher === 'string') return url.toString().includes(matcher)
  if (matcher instanceof RegExp) return matcher.test(url.toString())
  return matcher(url)
}

export class FakeFetch {
  readonly calls: FakeCall[] = []
  readonly #routes: Route[] = []

  route(match: Matcher, reply: FakeReply | ReplyFactory, times?: number): this {
    this.#routes.push({ match, reply, remaining: times })
    return this
  }

  readonly handler = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url)
    const headers = new Headers(init?.headers ?? {})
    const headerRecord: Record<string, string> = {}
    headers.forEach((value, key) => {
      headerRecord[key] = value
    })
    const call: FakeCall = {
      url: url.toString(),
      method: init?.method ?? 'GET',
      body: typeof init?.body === 'string' ? init.body : undefined,
      headers: headerRecord,
    }
    const index = this.calls.push(call) - 1

    for (const route of this.#routes) {
      if (!matches(route.match, url)) continue
      if (route.remaining !== undefined) {
        if (route.remaining <= 0) continue
        route.remaining -= 1
      }
      const reply =
        typeof route.reply === 'function' ? route.reply(url, call, index) : route.reply
      return buildResponse(reply)
    }

    return buildResponse({
      status: 404,
      json: { code: -404, message: `FakeFetch 未匹配到路由: ${url.pathname}` },
    })
  }

  /** 便于 `new BiliHttp({ fetchImpl: fake.handler })` */
  get fetchImpl(): typeof fetch {
    return this.handler as unknown as typeof fetch
  }

  urls(): string[] {
    return this.calls.map((call) => call.url)
  }
}

function buildResponse(reply: FakeReply): Response {
  const headers = new Headers(reply.headers ?? {})
  for (const cookie of reply.setCookies ?? []) headers.append('set-cookie', cookie)

  if (reply.json !== undefined) {
    if (!headers.has('content-type')) headers.set('content-type', 'application/json')
    return new Response(JSON.stringify(reply.json), { status: reply.status ?? 200, headers })
  }
  return new Response(reply.text ?? '', { status: reply.status ?? 200, headers })
}

/** 造一个可控时间源（配合 sleep 注入，避免测试真的等待） */
export function makeFakeClock(startMs = 1_700_000_000_000): {
  now: () => number
  advance: (ms: number) => void
  sleeps: number[]
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>
} {
  let current = startMs
  const sleeps: number[] = []
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms
    },
    sleeps,
    sleep: async (ms: number, signal?: AbortSignal) => {
      if (signal?.aborted) throw signal.reason ?? new Error('aborted')
      sleeps.push(ms)
      current += ms
    },
  }
}
