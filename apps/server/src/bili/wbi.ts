import { createHmac } from 'node:crypto'
import { navSchema } from '@mediagrab/shared'
import type { Logger } from '../lib/logger.js'
import { silentLogger } from '../lib/logger.js'
import { ApiError } from '../lib/errors.js'
import type { WbiKeyRepository } from '../store/repositories.js'
import type { BiliHttp } from './http.js'

/**
 * WBI 签名（ADR-10 / RISK §3.7）。
 *
 * 要点：
 * 1. `wbi_img` 的 key **按自然日轮换**，因此缓存必须带"哪一天取的"，跨天自动重取；
 * 2. `wts` 必须用**校正后的时钟**（`Clock`），本机时钟偏差会让所有签名请求失败；
 * 3. key 来自 `nav`，而**匿名 `nav` 返回 `code=-101`**（未登录）却仍然下发 `wbi_img` ——
 *    这是免登链路能成立的关键事实，出网层必须显式放行 -101。
 */

/** mixinKey 的置换表（B站前端固定算法） */
export const MIXIN_KEY_ENC_TAB: readonly number[] = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28,
  14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21,
  56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52,
]

export const NAV_URL = 'https://api.bilibili.com/x/web-interface/nav'

/** 从 `wbi_img` 的 URL 里取出 key（文件名去掉扩展名） */
export function wbiKeyFromUrl(url: string): string {
  const last = url.slice(url.lastIndexOf('/') + 1)
  const dot = last.indexOf('.')
  return dot >= 0 ? last.slice(0, dot) : last
}

/** img_key + sub_key 经置换表取前 32 位，得到签名密钥 */
export function mixinKeyFrom(imgKey: string, subKey: string): string {
  const raw = imgKey + subKey
  let out = ''
  for (const index of MIXIN_KEY_ENC_TAB) {
    const char = raw[index]
    if (char === undefined) continue
    out += char
  }
  return out.slice(0, 32)
}

/**
 * 对参数签名。
 *
 * 规则（与 B站前端一致）：值里过滤 `!'()*` → 按参数名 ASCII 排序 → 拼接 query →
 * `w_rid = HMAC-MD5(query, mixin_key)` → **把 w_rid 追加到 query 末尾**。
 *
 * 返回值里的 `query` 是**可直接发送的完整查询串**（含 `w_rid`）：
 * 调用方拼接 URL 时不需要再记住"别忘了加 w_rid"这件事 —— 漏掉它服务端会直接拒绝，
 * 而错误信息（-403/-412）完全指不到签名，是最难排查的一类 bug。
 */
export function signWbiParams(
  params: Readonly<Record<string, string | number>>,
  mixinKey: string,
  wts: number,
): { query: string; w_rid: string; wts: number } {
  const merged: Record<string, string> = {}
  for (const [key, value] of Object.entries(params)) {
    merged[key] = String(value).replace(/[!'()*]/g, '')
  }
  merged.wts = String(wts)

  const base = Object.keys(merged)
    .sort()
    .map((key) => `${encodeURIComponent(key)}=${encodeURIComponent(merged[key] ?? '')}`)
    .join('&')
  const w_rid = createHmac('md5', mixinKey).update(base).digest('hex')
  return { query: `${base}&w_rid=${w_rid}`, w_rid, wts }
}

export interface WbiKeyPair {
  imgKey: string
  subKey: string
  mixinKey: string
  fetchedAt: number
}

export interface WbiKeyServiceOptions {
  http: BiliHttp
  /** 不传则为纯内存缓存（测试/无库场景） */
  repo?: WbiKeyRepository
  logger?: Logger
}

/** 本地自然日字符串（key 按自然日轮换，跨天必须重取） */
function localDay(atMs: number): string {
  return new Date(atMs).toDateString()
}

export class WbiKeyService {
  readonly #http: BiliHttp
  readonly #repo: WbiKeyRepository | undefined
  readonly #logger: Logger
  #cached: WbiKeyPair | undefined

  constructor(options: WbiKeyServiceOptions) {
    this.#http = options.http
    this.#repo = options.repo
    this.#logger = options.logger ?? silentLogger
  }

  /** 当前缓存（未取过则为 undefined），供健康检查展示 */
  peek(): WbiKeyPair | undefined {
    if (this.#cached) return this.#cached
    const stored = this.#repo?.get()
    if (!stored) return undefined
    return this.#toPair(stored.imgKey, stored.subKey, stored.fetchedAt)
  }

  /**
   * 取签名密钥：同一天内复用，跨天或首次则请求 `nav`。
   * `nav` 失败时若手上还有当天的缓存则降级复用（只 warn），否则抛出。
   */
  async get(): Promise<WbiKeyPair> {
    const cached = this.peek()
    if (cached && this.#isFresh(cached)) {
      this.#cached = cached
      return cached
    }

    try {
      const pair = await this.refresh()
      return pair
    } catch (err) {
      if (cached) {
        this.#logger.warn(
          { err, fetchedAt: cached.fetchedAt },
          'nav 取 WBI key 失败，降级复用当天已缓存的 key',
        )
        this.#cached = cached
        return cached
      }
      throw err
    }
  }

  /** 强制重新获取（跨天、或签名报错时手动触发） */
  async refresh(): Promise<WbiKeyPair> {
    const response = await this.#http.json(navSchema, NAV_URL, {
      class: 'api',
      // 匿名 nav 返回 -101（未登录）但仍下发 wbi_img，必须放行
      acceptCodes: [0, -101],
      referer: 'https://www.bilibili.com/',
      label: 'wbi:nav',
    })

    const wbiImg = response.envelope.data?.wbi_img
    if (!wbiImg || !wbiImg.img_url || !wbiImg.sub_url) {
      throw new ApiError(
        'WBI_KEY_MISSING',
        'nav 响应里没有 wbi_img，无法进行 WBI 签名（接口可能已变更）',
        'fatal',
        502,
      )
    }

    const imgKey = wbiKeyFromUrl(wbiImg.img_url)
    const subKey = wbiKeyFromUrl(wbiImg.sub_url)
    const fetchedAt = this.#http.clock.nowMs()
    this.#repo?.save({ imgKey, subKey, fetchedAt })

    const pair = this.#toPair(imgKey, subKey, fetchedAt)
    this.#cached = pair
    this.#logger.info({ imgKey, fetchedAt, day: localDay(fetchedAt) }, 'WBI key 已更新')
    return pair
  }

  #toPair(imgKey: string, subKey: string, fetchedAt: number): WbiKeyPair {
    return { imgKey, subKey, mixinKey: mixinKeyFrom(imgKey, subKey), fetchedAt }
  }

  #isFresh(pair: WbiKeyPair): boolean {
    return localDay(pair.fetchedAt) === localDay(this.#http.clock.nowMs())
  }
}
