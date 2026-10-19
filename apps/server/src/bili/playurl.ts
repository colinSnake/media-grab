import {
  AUDIO_QUALITY_META,
  FNVAL_MAX,
  QN,
  audioAvailabilityFor,
  availabilityFor,
  playurlSchema,
  qualityMeta,
  streamUrl,
  type AccountSession,
  type AudioAvailability,
  type DashStream,
  type QualityAvailability,
  type StreamSummary,
} from '@mediagrab/shared'
import { ApiError } from '../lib/errors.js'
import type { RetryPolicy } from '../lib/retry.js'
import { biliVideoReferer, STREAM_URL_TTL_SEC, type BiliHttp } from './http.js'
import { signWbiParams, type WbiKeyService } from './wbi.js'

/**
 * 取流 + 档位可用性标注（FR-03 / ADR-7 / ADR-12）。
 *
 * **铁律**：可用性只能按 `dash.video[].id` 的**实际交付**判定。
 * 匿名实测 `BV1GJ411x7h7`：`accept_quality=[112,80,64,32,16]`（声称支持 1080P+），
 * 而 `dash.video[].id` 只有 `[16,32]`（360P/480P）。用 `accept_quality` 决定"能不能点"
 * 会让用户以为能下 1080P，然后下载失败 —— 这正是本设计要避免的。
 *
 * 另一个要点：dash 模式下 `qn` 参数**不生效**，所以固定请求 `qn=127&fnval=4048`
 * 一次拿齐服务端可见的全部档位，再按身份筛选。
 */

export const PLAYURL_WBI_URL = 'https://api.bilibili.com/x/player/wbi/playurl'

export interface PlayurlBundle {
  bvid: string
  cid: number
  durationSec: number
  session: AccountSession
  /** 视频档位可用性（按实际交付判定） */
  qualities: QualityAvailability[]
  /** 音频档位可用性（含杜比 / Hi-Res） */
  audioQualities: AudioAvailability[]
  /** 实际交付的视频流候选（已带可直接下载的 URL） */
  video: StreamSummary[]
  /** 实际交付的音频流候选 */
  audio: StreamSummary[]
  urlTtlSec: number
}

export interface FetchPlayurlOptions {
  bvid: string
  cid: number
  session?: AccountSession
  signal?: AbortSignal
  retryPolicy?: RetryPolicy
}

const ANONYMOUS: AccountSession = { loggedIn: false, vip: false }

/** dash 流 → 前端/下载引擎用的候选（没有可用 URL 的流直接丢掉，避免"看得见下不了"） */
function toSummary(stream: DashStream): StreamSummary | undefined {
  const url = streamUrl(stream)
  if (!url) return undefined
  return {
    id: stream.id,
    codecid: stream.codecid,
    codecs: stream.codecs,
    width: stream.width,
    height: stream.height,
    bandwidth: stream.bandwidth,
    mimeType: stream.mimeType ?? stream.mime_type,
    url,
    backupUrls: stream.backup_url ?? stream.backupUrl ?? [],
  }
}

function uniqueSorted(ids: readonly number[]): number[] {
  return [...new Set(ids)].sort((a, b) => b - a)
}

export async function fetchPlayurl(
  http: BiliHttp,
  wbi: WbiKeyService,
  options: FetchPlayurlOptions,
): Promise<PlayurlBundle> {
  const session = options.session ?? ANONYMOUS
  const { bvid, cid } = options
  const keys = await wbi.get()

  // 签名后的 query 直接拼进 URL：保证"签的"和"发的"字节一致
  const params: Record<string, string | number> = {
    bvid,
    cid,
    qn: QN.Q8K,
    fnval: FNVAL_MAX,
    fnver: 0,
    fourk: 1,
  }
  const { query } = signWbiParams(params, keys.mixinKey, http.clock.nowSec())

  const response = await http.json(playurlSchema, `${PLAYURL_WBI_URL}?${query}`, {
    class: 'playurl',
    referer: biliVideoReferer(bvid),
    acceptCodes: [0],
    signal: options.signal,
    retryPolicy: options.retryPolicy,
    messageOverride: {
      [-403]: '该清晰度需要大会员，或当前身份无播放权限',
      [-10403]: '该内容在当前地区/身份下不可播放',
      [-101]: '该清晰度需要登录后才能获取',
    },
    label: 'playurl:wbi',
  })

  const data = response.envelope.data
  if (!data?.dash) {
    // 明确失败，绝不静默降级（ADR-7）
    throw new ApiError(
      'NO_DASH_STREAM',
      '接口未返回 dash 流（可能是稿件状态或接口行为变化），无法确定可用档位',
      'fatal',
      502,
    )
  }

  const videoStreams = data.dash.video
  const audioStreams = data.dash.audio
  const flac = data.dash.flac?.audio
  const dolby = data.dash.dolby?.audio ?? []

  const deliveredVideoIds = uniqueSorted(videoStreams.map((stream) => stream.id))
  const deliveredAudioIds = uniqueSorted([
    ...audioStreams.map((stream) => stream.id),
    ...dolby.map((stream) => stream.id),
    ...(flac ? [flac.id] : []),
  ])

  const video = videoStreams
    .map(toSummary)
    .filter((item): item is StreamSummary => item !== undefined)
    .sort((a, b) => b.id - a.id)
  const audio = [...audioStreams, ...dolby, ...(flac ? [flac] : [])]
    .map(toSummary)
    .filter((item): item is StreamSummary => item !== undefined)
    .sort((a, b) => b.id - a.id)

  return {
    bvid,
    cid,
    // dash 模式下时长在 dash 里（顶层没有 duration）
    durationSec: Math.max(0, Math.round(data.dash.duration ?? 0)),
    session,
    qualities: availabilityFor(data.accept_quality, deliveredVideoIds, session),
    audioQualities: audioAvailabilityFor(deliveredAudioIds, session),
    video,
    audio,
    urlTtlSec: STREAM_URL_TTL_SEC,
  }
}

/** 视频档位标签（供路由/前端复用，避免各自维护一份） */
export function qualityLabel(qn: number): string {
  return qualityMeta(qn)?.label ?? `${qn}`
}

/** 音频档位标签 */
export function audioQualityLabel(id: number): string {
  return AUDIO_QUALITY_META.find((meta) => meta.id === id)?.label ?? `${id}`
}
