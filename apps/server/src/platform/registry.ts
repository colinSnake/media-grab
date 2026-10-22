import {
  type MediaParseResult,
  type MediaStream,
  parseMediaInput,
  platformCatalog,
  platformLabel,
  type ParseResult,
  type ExtractorPlatform,
  type Platform,
} from '@mediagrab/shared'
import { ApiError } from '../lib/errors.js'
import type { BiliClient } from '../bili/client.js'
import { biliVideoReferer } from '../bili/http.js'
import type { ConfigStore } from '../lib/config-store.js'
import type { Logger } from '../lib/logger.js'
import { checkYtDlp, YtDlpAdapter } from './ytdlp.js'

export interface PlatformAdapter {
  readonly platform: Platform
  parse(input: string, page?: number): Promise<ParseResult>
}

export interface MediaAdapter {
  readonly platform: Exclude<Platform, 'unknown'>
  parse(input: string, options?: { signal?: AbortSignal }): Promise<MediaParseResult>
}

class BilibiliAdapter implements PlatformAdapter {
  readonly platform = 'bilibili' as const
  #client: BiliClient

  constructor(client: BiliClient) {
    this.#client = client
  }

  parse(input: string, page?: number): Promise<ParseResult> {
    return this.#client.parse(input, page)
  }
}

export class PlatformRegistry {
  #adapters = new Map<Platform, PlatformAdapter>()

  constructor(bili: BiliClient) {
    this.register(new BilibiliAdapter(bili))
  }

  register(adapter: PlatformAdapter): void {
    this.#adapters.set(adapter.platform, adapter)
  }

  async parse(input: string, page?: number): Promise<ParseResult> {
    const detected = parseMediaInput(input)
    if (!detected.ok) throw new ApiError('INVALID_INPUT', detected.reason, 'invalid', 400)

    const adapter = this.#adapters.get(detected.value.platform)
    if (adapter === undefined) {
      const label = platformLabel[detected.value.platform]
      throw new ApiError(
        'UNSUPPORTED_PLATFORM',
        `${label}链接已识别，但该平台适配器还未接入。`,
        'invalid',
        422,
      )
    }
    return adapter.parse(detected.value.raw, page)
  }
}

function mapBiliStreams(result: Awaited<ReturnType<BiliClient['playurl']>>, bvid: string): MediaStream[] {
  return [
    ...result.video.map((stream) => ({
      id: `video:${stream.id}`,
      kind: 'video' as const,
      combined: false,
      label: stream.height === undefined ? `${stream.id}` : `${stream.height}P`,
      url: stream.url,
      backupUrls: stream.backupUrls,
      width: stream.width,
      height: stream.height,
      codecs: stream.codecs,
      mimeType: stream.mimeType,
      httpHeaders: { Referer: biliVideoReferer(bvid) },
      bitrate: stream.bandwidth,
      available: true,
      reason: '',
    })),
    ...result.audio.map((stream) => ({
      id: `audio:${stream.id}`,
      kind: 'audio' as const,
      combined: false,
      label: stream.id === 30280 ? '192K' : stream.id === 30232 ? '132K' : `${stream.id}`,
      url: stream.url,
      backupUrls: stream.backupUrls,
      codecs: stream.codecs,
      mimeType: stream.mimeType,
      httpHeaders: { Referer: biliVideoReferer(bvid) },
      bitrate: stream.bandwidth,
      available: true,
      reason: '',
    })),
  ]
}

class BilibiliMediaAdapter implements MediaAdapter {
  readonly platform = 'bilibili' as const
  #client: BiliClient

  constructor(client: BiliClient) {
    this.#client = client
  }

  async parse(input: string, options?: { signal?: AbortSignal }): Promise<MediaParseResult> {
    const result = await this.#client.parse(input)
    const streams = mapBiliStreams(await this.#client.playurl(result.bvid, result.cid, options), result.bvid)
    return {
      platform: 'bilibili',
      input: result.input,
      id: result.bvid,
      title: result.title,
      authorName: result.ownerName,
      cover: result.cover,
      durationSec: result.durationSec,
      streams,
      itemCount: result.pages.length,
      capabilities: {
        video: streams.some((stream) => stream.kind === 'video'),
        audio: streams.some((stream) => stream.kind === 'audio'),
        image: false,
        download: streams.length > 0,
      },
    }
  }
}

export class MediaRegistry {
  #adapters = new Map<Exclude<Platform, 'unknown'>, MediaAdapter>()
  #bili: BiliClient
  #config: ConfigStore
  #ytDlpAdapters = new Map<ExtractorPlatform, YtDlpAdapter>()
  #cookieProviders: Partial<Record<ExtractorPlatform, () => string | undefined>>
  #extractorStatusCache?: { candidate: string; checkedAt: number; value: Awaited<ReturnType<typeof checkYtDlp>> }
  #extractorStatusInFlight?: { candidate: string; promise: ReturnType<typeof checkYtDlp> }

  constructor(options: { bili: BiliClient; config: ConfigStore; logger?: Logger; cookieProviders?: Partial<Record<ExtractorPlatform, () => string | undefined>> }) {
    this.#bili = options.bili
    this.#config = options.config
    this.#cookieProviders = options.cookieProviders ?? {}
    this.register(new BilibiliMediaAdapter(options.bili))
    const executable = options.config.get().ytDlpPath
    for (const { platform } of platformCatalog
      .filter((item): item is typeof item & { platform: ExtractorPlatform } => item.requiresExtractor)
    ) {
      const adapter = new YtDlpAdapter({ platform, executable, cookieProvider: this.#cookieProviders[platform], logger: options.logger })
      this.#ytDlpAdapters.set(platform, adapter)
      this.register(adapter)
    }
  }

  register(adapter: MediaAdapter): void {
    this.#adapters.set(adapter.platform, adapter)
  }

  platformReadiness(platform: Exclude<Platform, 'unknown'>, extractorAvailable: boolean): { ready: boolean; reason: string } {
    const definition = platformCatalog.find((item) => item.platform === platform)
    if (definition === undefined || !definition.parse) return { ready: false, reason: '平台未启用' }
    if (!this.#adapters.has(platform)) return { ready: false, reason: '平台适配器未注册' }
    if (definition.requiresExtractor && !extractorAvailable) return { ready: false, reason: '需要 yt-dlp extractor' }
    return { ready: true, reason: '' }
  }

  extractorStatus(): ReturnType<typeof checkYtDlp> {
    const candidate = this.#config.get().ytDlpPath.trim()
    const now = Date.now()
    if (this.#extractorStatusCache?.candidate === candidate && now - this.#extractorStatusCache.checkedAt < 30_000) {
      return Promise.resolve(this.#extractorStatusCache.value)
    }
    if (this.#extractorStatusInFlight?.candidate === candidate) return this.#extractorStatusInFlight.promise
    const promise = checkYtDlp(candidate).then((value) => {
      this.#extractorStatusCache = { candidate, checkedAt: Date.now(), value }
      return value
    }).finally(() => {
      if (this.#extractorStatusInFlight?.promise === promise) this.#extractorStatusInFlight = undefined
    })
    this.#extractorStatusInFlight = { candidate, promise }
    return promise
  }

  async parse(input: string): Promise<MediaParseResult> {
    const detected = parseMediaInput(input)
    if (!detected.ok) throw new ApiError('INVALID_INPUT', detected.reason, 'invalid', 400)
    if (detected.value.platform === 'unknown') throw new ApiError('INVALID_INPUT', '无法识别来源', 'invalid', 400)
    const adapter = this.#adapters.get(detected.value.platform)
    if (adapter === undefined) {
      throw new ApiError('UNSUPPORTED_PLATFORM', '该平台适配器还未接入。', 'invalid', 422)
    }
    const ytdlp = this.#ytDlpAdapters.get(detected.value.platform as ExtractorPlatform)
    if (ytdlp !== undefined) {
      ytdlp.setExecutable(this.#config.get().ytDlpPath)
      ytdlp.setCookieProvider(this.#cookieProviders[ytdlp.platform] ?? (() => undefined))
    }
    return adapter.parse(detected.value.raw)
  }

  async streamsForDownload(options: { platform: Exclude<Platform, 'unknown'>; input: string; bvid?: string; cid?: number; signal?: AbortSignal }): Promise<MediaStream[]> {
    if (options.platform === 'bilibili') {
      if (options.bvid === undefined || options.cid === undefined) throw new ApiError('INVALID_TASK', 'B站任务缺少 bvid/cid', 'invalid', 400)
      const result = await this.#bili.playurl(options.bvid, options.cid, { signal: options.signal })
      return mapBiliStreams(result, options.bvid)
    }

    const detected = parseMediaInput(options.input)
    if (!detected.ok) throw new ApiError('INVALID_INPUT', detected.reason, 'invalid', 400)
    if (detected.value.platform !== options.platform) throw new ApiError('INVALID_TASK', '解析结果与任务来源不一致', 'invalid', 400)
    const adapter = this.#adapters.get(options.platform)
    if (adapter === undefined) throw new ApiError('UNSUPPORTED_PLATFORM', '该平台适配器还未接入。', 'invalid', 422)
    const ytdlp = this.#ytDlpAdapters.get(options.platform as ExtractorPlatform)
    if (ytdlp !== undefined) {
      ytdlp.setExecutable(this.#config.get().ytDlpPath)
      ytdlp.setCookieProvider(this.#cookieProviders[ytdlp.platform] ?? (() => undefined))
    }
    return (await adapter.parse(detected.value.raw, { signal: options.signal })).streams
  }
}
