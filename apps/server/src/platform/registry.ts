import {
  type MediaParseResult,
  type MediaStream,
  parseMediaInput,
  type ParseResult,
  type Platform,
} from '@mediagrab/shared'
import { ApiError } from '../lib/errors.js'
import type { BiliClient } from '../bili/client.js'
import type { ConfigStore } from '../lib/config-store.js'
import type { Logger } from '../lib/logger.js'
import { checkYtDlp, YtDlpAdapter } from './ytdlp.js'

export interface PlatformAdapter {
  readonly platform: Platform
  parse(input: string, page?: number): Promise<ParseResult>
}

export interface MediaAdapter {
  readonly platform: Exclude<Platform, 'unknown'>
  parse(input: string): Promise<MediaParseResult>
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
      const label = detected.value.platform === 'douyin' ? '抖音' : '小红书'
      throw new ApiError(
        'UNSUPPORTED_PLATFORM',
        `${label}链接已识别，但该平台适配器还未接入。当前可用平台：B站。`,
        'invalid',
        422,
      )
    }
    return adapter.parse(detected.value.raw, page)
  }
}

function mapBiliStreams(result: Awaited<ReturnType<BiliClient['playurl']>>): MediaStream[] {
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

  async parse(input: string): Promise<MediaParseResult> {
    const result = await this.#client.parse(input)
    const streams = mapBiliStreams(await this.#client.playurl(result.bvid, result.cid))
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
  #config: ConfigStore
  #ytDlpAdapters: YtDlpAdapter[] = []
  #cookieProviders: Record<'douyin' | 'xiaohongshu', () => string | undefined>

  constructor(options: { bili: BiliClient; config: ConfigStore; logger?: Logger; cookieProviders?: Partial<Record<'douyin' | 'xiaohongshu', () => string | undefined>> }) {
    this.#config = options.config
    this.#cookieProviders = {
      douyin: options.cookieProviders?.douyin ?? (() => undefined),
      xiaohongshu: options.cookieProviders?.xiaohongshu ?? (() => undefined),
    }
    this.register(new BilibiliMediaAdapter(options.bili))
    const executable = options.config.get().ytDlpPath
    const douyin = new YtDlpAdapter({ platform: 'douyin', executable, cookieProvider: this.#cookieProviders.douyin, logger: options.logger })
    const xiaohongshu = new YtDlpAdapter({ platform: 'xiaohongshu', executable, cookieProvider: this.#cookieProviders.xiaohongshu, logger: options.logger })
    this.#ytDlpAdapters = [douyin, xiaohongshu]
    this.register(douyin)
    this.register(xiaohongshu)
  }

  register(adapter: MediaAdapter): void {
    this.#adapters.set(adapter.platform, adapter)
  }

  extractorStatus(): ReturnType<typeof checkYtDlp> {
    return checkYtDlp(this.#config.get().ytDlpPath)
  }

  async parse(input: string): Promise<MediaParseResult> {
    const detected = parseMediaInput(input)
    if (!detected.ok) throw new ApiError('INVALID_INPUT', detected.reason, 'invalid', 400)
    if (detected.value.platform === 'unknown') throw new ApiError('INVALID_INPUT', '无法识别来源', 'invalid', 400)
    const adapter = this.#adapters.get(detected.value.platform)
    if (adapter === undefined) {
      throw new ApiError('UNSUPPORTED_PLATFORM', '该平台适配器还未接入。', 'invalid', 422)
    }
    const executable = this.#config.get().ytDlpPath
    for (const ytdlp of this.#ytDlpAdapters) {
      ytdlp.setExecutable(executable)
      ytdlp.setCookieProvider(this.#cookieProviders[ytdlp.platform])
    }
    return adapter.parse(detected.value.raw)
  }
}
