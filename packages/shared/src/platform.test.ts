import { describe, expect, it } from 'vitest'
import { detectPlatform, parseMediaInput } from './platform.js'
import { mediaParseResultSchema } from './media.js'

describe('platform input', () => {
  it('识别三类首批平台', () => {
    expect(detectPlatform('BV1GJ411x7h7')).toBe('bilibili')
    expect(detectPlatform('https://v.douyin.com/abc123/')).toBe('douyin')
    expect(detectPlatform('https://www.xiaohongshu.com/explore/abc')).toBe('xiaohongshu')
  })

  it('从平台分享文案中抽取短链', () => {
    const result = parseMediaInput('7.68 复制打开抖音，看看这个视频 https://v.douyin.com/abc123/ 复制此链接')
    expect(result).toEqual({
      ok: true,
      value: { platform: 'douyin', raw: 'https://v.douyin.com/abc123/', url: 'https://v.douyin.com/abc123/' },
    })
  })

  it('从 Markdown 链接中抽取 B站地址并还原转义参数', () => {
    const result = parseMediaInput('[视频](https://www.bilibili.com/video/BV149jo6nEYB/?t=35.8\\&vd_source=share)')
    expect(result).toEqual({
      ok: true,
      value: {
        platform: 'bilibili',
        raw: 'https://www.bilibili.com/video/BV149jo6nEYB/?t=35.8&vd_source=share',
        value: { kind: 'bvid', bvid: 'BV149jo6nEYB' },
      },
    })
  })

  it('保留 B站规范化结果', () => {
    const result = parseMediaInput('https://www.bilibili.com/video/BV1GJ411x7h7?p=2')
    expect(result).toEqual({
      ok: true,
      value: {
        platform: 'bilibili',
        raw: 'https://www.bilibili.com/video/BV1GJ411x7h7?p=2',
        value: { kind: 'bvid', bvid: 'BV1GJ411x7h7', page: 2 },
      },
    })
  })

  it('未知来源给出统一文案', () => {
    expect(parseMediaInput('https://example.com/video/1')).toEqual({
      ok: false,
      reason: '无法识别来源，支持 B站、抖音和小红书链接',
    })
  })

  it('通用媒体结果保留视频、音频和能力矩阵', () => {
    const result = mediaParseResultSchema.parse({
      platform: 'douyin', input: 'https://v.douyin.com/a/', id: '123',
      title: 'demo', streams: [{ id: 'video:default', kind: 'video', url: 'https://cdn.example.com/a.mp4' }],
      capabilities: { video: true, audio: false, image: false, download: true },
    })
    expect(result.streams[0]?.kind).toBe('video')
    expect(result.itemCount).toBe(1)
  })
})
