import { videoViewSchema, type VideoPage } from '@mediagrab/shared'
import { ApiError } from '../lib/errors.js'
import type { BiliHttp } from './http.js'

/**
 * 视频详情（`x/web-interface/view`）。
 * 免登可访问，用于拿标题 / UP 主 / 封面 / 分P 列表 / cid。
 */

export const VIEW_URL = 'https://api.bilibili.com/x/web-interface/view'

export interface VideoDetail {
  bvid: string
  avid: number
  /** 默认分P 的 cid */
  cid: number
  title: string
  cover: string
  durationSec: number
  owner: { mid: number; name: string }
  pages: VideoPage[]
}

export type VideoRef = { bvid: string } | { avid: number }

/** B站详情接口偶尔返回 http 封面；网页和桌面 WebView 统一使用 HTTPS，避免混合内容拦截。 */
export function normalizeCoverUrl(url: string): string {
  return url.replace(/^http:\/\//i, 'https://')
}

export async function fetchVideoDetail(http: BiliHttp, ref: VideoRef): Promise<VideoDetail> {
  const query =
    'bvid' in ref ? { bvid: ref.bvid } : { aid: ref.avid }

  const response = await http.json(videoViewSchema, VIEW_URL, {
    class: 'api',
    query,
    referer: 'https://www.bilibili.com/',
    acceptCodes: [0],
    messageOverride: {
      [-404]: '稿件不存在或已被删除',
      [-403]: '该稿件在当前身份下不可访问',
    },
    label: 'video:view',
  })

  const data = response.envelope.data
  if (!data) {
    throw new ApiError('VIDEO_NOT_FOUND', '接口未返回视频信息', 'notFound', 404)
  }

  const pages: VideoPage[] = data.pages.length > 0 ? data.pages : [
    { cid: data.cid, page: 1, part: data.title, duration: data.duration },
  ]

  return {
    bvid: data.bvid,
    avid: data.aid,
    cid: data.cid,
    title: data.title,
    cover: normalizeCoverUrl(data.pic),
    durationSec: Math.max(0, Math.round(data.duration)),
    owner: { mid: data.owner.mid, name: data.owner.name },
    pages,
  }
}
