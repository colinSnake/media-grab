import { describe, expect, it } from 'vitest'
import { playurlSchema, streamUrl, videoViewSchema } from './index.js'

/**
 * 真实响应形状回归（M1-9 匿名实测抓取）。
 *
 * 教训：`dash.dolby.audio` / `dash.flac` / `data.high_format` / `data.view_info`
 * 在匿名 playurl 响应里是**显式 null**。用 `.optional()` 建模会在第一次真实请求时
 * 直接抛"响应结构与预期不符"，而单测因为夹具是自己写的"干净"数据完全发现不了。
 */
const REAL_ANONYMOUS_PLAYURL = {
  code: 0,
  message: 'OK',
  ttl: 1,
  data: {
    quality: 64,
    accept_quality: [112, 80, 64, 32, 16],
    accept_description: ['1080P+ 高码率', '1080P 高清', '720P 高清', '480P 清晰', '360P 流畅'],
    high_format: null,
    view_info: null,
    support_formats: [{ quality: 112, new_description: '1080P+ 高码率', can_watch_qn_reason: 1 }],
    dash: {
      duration: 213,
      minBufferTime: 1.5,
      video: [
        {
          id: 32,
          baseUrl: 'https://cdn.example.com/32-avc.m4s',
          base_url: 'https://cdn.example.com/32-avc.m4s',
          backupUrl: ['https://backup.example.com/32-avc.m4s'],
          backup_url: [],
          bandwidth: 748_831,
          mimeType: 'video/mp4',
          mime_type: 'video/mp4',
          codecs: 'avc1.64001f',
          width: 852,
          height: 480,
          frameRate: '25',
          sar: '1:1',
          startWithSap: 1,
          SegmentBase: { Initialization: '0-1' },
          codecid: 7,
        },
      ],
      audio: [
        {
          id: 30280,
          base_url: 'https://cdn.example.com/30280.m4s',
          backup_url: null,
          bandwidth: 320_000,
          mime_type: 'audio/mp4',
          codecs: 'mp4a.40.2',
          codecid: 0,
        },
      ],
      dolby: { type: 0, audio: null },
      flac: null,
    },
  },
}

describe('playurlSchema 必须能吃下真实响应（含显式 null）', () => {
  it('匿名实测形状可以解析，null 收敛成空/undefined', () => {
    const parsed = playurlSchema.parse(REAL_ANONYMOUS_PLAYURL)

    expect(parsed.data?.accept_quality).toEqual([112, 80, 64, 32, 16])
    expect(parsed.data?.dash?.video).toHaveLength(1)
    expect(parsed.data?.dash?.audio).toHaveLength(1)
    // dolby 存在但 audio 为 null → 空数组；flac 为 null → undefined
    expect(parsed.data?.dash?.dolby?.audio).toEqual([])
    expect(parsed.data?.dash?.flac).toBeUndefined()

    const video = parsed.data?.dash?.video[0]
    expect(video?.codecid).toBe(7)
    expect(streamUrl(video!)).toBe('https://cdn.example.com/32-avc.m4s')

    const audio = parsed.data?.dash?.audio[0]
    // backup_url: null → undefined（而不是抛错）
    expect(audio?.backup_url).toBeUndefined()
    expect(streamUrl(audio!)).toBe('https://cdn.example.com/30280.m4s')
  })

  it('视频/音频数组为 null 时收敛成空数组', () => {
    const parsed = playurlSchema.parse({
      code: 0,
      data: { dash: { video: null, audio: null, dolby: null, flac: null } },
    })
    expect(parsed.data?.dash?.video).toEqual([])
    expect(parsed.data?.dash?.audio).toEqual([])
    expect(parsed.data?.dash?.dolby).toBeUndefined()
  })

  it('大会员场景的 flac / 杜比音频也能解析', () => {
    const parsed = playurlSchema.parse({
      code: 0,
      data: {
        dash: {
          video: [],
          audio: [],
          dolby: {
            type: 2,
            audio: [{ id: 30250, base_url: 'https://cdn.example.com/dolby.m4s' }],
          },
          flac: { audio: { id: 30251, base_url: 'https://cdn.example.com/flac.m4s' } },
        },
      },
    })
    expect(parsed.data?.dash?.dolby?.audio[0]?.id).toBe(30250)
    expect(parsed.data?.dash?.flac?.audio?.id).toBe(30251)
  })
})

describe('videoViewSchema 的 null 容忍', () => {
  it('分P 字段为 null 时回落默认值', () => {
    const parsed = videoViewSchema.parse({
      code: 0,
      data: {
        bvid: 'BV1GJ411x7h7',
        aid: 170001,
        cid: 137649199,
        title: null,
        pic: null,
        duration: null,
        owner: { mid: 1, name: null },
        pages: null,
      },
    })
    expect(parsed.data?.title).toBe('')
    expect(parsed.data?.pic).toBe('')
    expect(parsed.data?.duration).toBe(0)
    expect(parsed.data?.owner.name).toBe('')
    expect(parsed.data?.pages).toEqual([])
  })
})
