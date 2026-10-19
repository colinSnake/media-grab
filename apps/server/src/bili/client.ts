import {
  parseBiliInput,
  type AccountSession,
  type ParseResult,
} from '@mediagrab/shared'
import { ApiError } from '../lib/errors.js'
import type { Logger } from '../lib/logger.js'
import { silentLogger } from '../lib/logger.js'
import type { FingerprintInitResult, FingerprintService } from './fingerprint.js'
import { BILI_HOME, type BiliHttp } from './http.js'
import { fetchPlayurl, type PlayurlBundle } from './playurl.js'
import { fetchVideoDetail, type VideoDetail, type VideoRef } from './view.js'
import type { WbiKeyService } from './wbi.js'

/**
 * 免登解析链路门面（FR-01 / FR-02 / FR-03）。
 *
 * 输入归一化 → 详情与分P → 取流与档位标注。默认匿名，也支持由本机账号服务提供登录态。
 * 解析链路不存在“必须先登录”的分支；登录只扩展平台实际返回的资源权限。
 */

/** M1 的默认身份：匿名 */
export const ANONYMOUS_SESSION: AccountSession = { loggedIn: false, vip: false }

const SHORT_LINK_MAX_HOPS = 3

export interface BiliClientOptions {
  http: BiliHttp
  wbi: WbiKeyService
  fingerprint: FingerprintService
  sessionProvider?: () => AccountSession
  logger?: Logger
}

export interface ResolvedInput {
  /** 归一化后的视频引用 */
  ref: VideoRef
  /** 目标分P（默认 1） */
  page: number
  /** 归一化后的原始输入（短链已解析） */
  normalized: string
}

export class BiliClient {
  readonly #http: BiliHttp
  readonly #wbi: WbiKeyService
  readonly #fingerprint: FingerprintService
  readonly #sessionProvider: () => AccountSession
  readonly #logger: Logger

  constructor(options: BiliClientOptions) {
    this.#http = options.http
    this.#wbi = options.wbi
    this.#fingerprint = options.fingerprint
    this.#sessionProvider = options.sessionProvider ?? (() => ANONYMOUS_SESSION)
    this.#logger = options.logger ?? silentLogger
  }

  get http(): BiliHttp {
    return this.#http
  }

  get fingerprint(): FingerprintService {
    return this.#fingerprint
  }

  /** 当前身份：无激活账号时匿名，有效的本机账号可提供登录/VIP摘要。 */
  session(): AccountSession {
    return this.#sessionProvider()
  }

  /** 启动初始化：指纹（必需）+ `bili_ticket`（增强，失败不阻塞） */
  async initialize(): Promise<FingerprintInitResult> {
    return this.#fingerprint.initialize()
  }

  /** 把用户输入（BV / av / 链接 / b23.tv 短链）归一化为视频引用 + 分P */
  async resolveInput(rawInput: string): Promise<ResolvedInput> {
    let current = rawInput.trim()
    for (let hop = 0; hop < SHORT_LINK_MAX_HOPS; hop += 1) {
      const parsed = parseBiliInput(current)
      if (!parsed.ok) {
        throw new ApiError('INVALID_INPUT', parsed.reason, 'invalid', 400)
      }
      const value = parsed.value
      const page = value.page ?? 1
      if (value.kind === 'bvid') return { ref: { bvid: value.bvid }, page, normalized: current }
      if (value.kind === 'avid') return { ref: { avid: value.avid }, page, normalized: current }
      current = await this.#followShortLink(value.url)
    }
    throw new ApiError(
      'SHORT_LINK_LOOP',
      '短链跳转次数过多，请直接粘贴视频链接',
      'invalid',
      400,
    )
  }

  /** 视频详情 + 分P 列表 */
  async detail(rawInput: string): Promise<{ detail: VideoDetail; page: number }> {
    const resolved = await this.resolveInput(rawInput)
    const detail = await fetchVideoDetail(this.#http, resolved.ref)
    return { detail, page: resolved.page }
  }

  /**
   * 解析入口：输入 → 视频信息 + 分P + **各档位可用性**。
   * 可用性取目标分P 的 playurl 实际交付结果（ADR-12）。
   */
  async parse(rawInput: string, page?: number): Promise<ParseResult> {
    const resolved = await this.resolveInput(rawInput)
    const detail = await fetchVideoDetail(this.#http, resolved.ref)
    const wanted = page ?? resolved.page
    const selected =
      detail.pages.find((item) => item.page === wanted) ?? detail.pages[wanted - 1]
    if (!selected) {
      throw new ApiError(
        'PAGE_NOT_FOUND',
        `该视频共 ${detail.pages.length} 个分P，找不到第 ${wanted} P`,
        'notFound',
        404,
      )
    }

    const bundle = await fetchPlayurl(this.#http, this.#wbi, {
      bvid: detail.bvid,
      cid: selected.cid,
      session: this.session(),
    })

    return {
      input: rawInput,
      bvid: detail.bvid,
      avid: detail.avid,
      cid: selected.cid,
      page: selected.page,
      title: detail.title,
      ownerMid: detail.owner.mid,
      ownerName: detail.owner.name,
      cover: detail.cover,
      durationSec: selected.duration > 0 ? selected.duration : detail.durationSec,
      pages: detail.pages,
      session: this.session(),
      qualities: bundle.qualities,
      audioQualities: bundle.audioQualities,
    }
  }

  /** 取流：返回候选流与可用性（M2 的下载引擎复用同一份结果） */
  async playurl(
    bvid: string,
    cid: number,
    options: { signal?: AbortSignal } = {},
  ): Promise<PlayurlBundle> {
    return fetchPlayurl(this.#http, this.#wbi, {
      bvid,
      cid,
      session: this.session(),
      signal: options.signal,
    })
  }

  /** b23.tv 短链：不跟随跳转，读 Location 再交回归一化（避免跳转链上的多余请求） */
  async #followShortLink(url: string): Promise<string> {
    const response = await this.#http.text(url, {
      class: 'other',
      redirect: 'manual',
      semantics: 'document',
      referer: BILI_HOME,
      label: 'shortlink:b23',
    })
    if (!response.location) {
      throw new ApiError(
        'SHORT_LINK_FAILED',
        '短链没有返回跳转地址（可能已失效或需要人工打开）',
        'notFound',
        404,
      )
    }
    try {
      return new URL(response.location, url).toString()
    } catch {
      throw new ApiError('SHORT_LINK_FAILED', '短链跳转地址无法解析', 'notFound', 404)
    }
  }
}
