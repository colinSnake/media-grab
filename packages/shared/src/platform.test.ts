import { describe, expect, it } from 'vitest'
import { detectPlatform, parseMediaInput, platformCoverReferer, platformForCoverHost, platformForHost } from './platform.js'
import { mediaParseResultSchema } from './media.js'

describe('platform input', () => {
  it('识别目录中配置的平台域名', () => {
    expect(detectPlatform('BV1GJ411x7h7')).toBe('bilibili')
    expect(detectPlatform('https://v.douyin.com/abc123/')).toBe('douyin')
    expect(detectPlatform('https://www.xiaohongshu.com/explore/abc')).toBe('xiaohongshu')
    expect(detectPlatform('https://youtu.be/dQw4w9WgXcQ')).toBe('youtube')
    expect(detectPlatform('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe('youtube')
  })

  it('从包含说明文字的 YouTube 分享文本中提取链接', () => {
    expect(parseMediaInput('Watch this video: https://youtu.be/dQw4w9WgXcQ?t=42')).toEqual({
      ok: true,
      value: {
        platform: 'youtube',
        raw: 'https://youtu.be/dQw4w9WgXcQ?t=42',
        url: 'https://youtu.be/dQw4w9WgXcQ?t=42',
      },
    })
  })

  it('不会把伪造的平台后缀域名当作受支持来源', () => {
    expect(detectPlatform('https://youtube.com.example.org/watch?v=1')).toBe('unknown')
    expect(detectPlatform('https://notyoutube.com/watch?v=1')).toBe('unknown')
  })

  it('按最长后缀边界匹配平台域名，并忽略末尾点号', () => {
    expect(platformForHost('WWW.YouTube.COM.')).toBe('youtube')
    expect(platformForHost('cdn.youtube.com.example.org')).toBeUndefined()
    expect(platformForHost('xhslink.com')).toBe('xiaohongshu')
  })

  it('从共享目录解析封面 CDN 白名单和回源地址', () => {
    expect(platformForCoverHost('i.ytimg.com')).toBe('youtube')
    expect(platformCoverReferer('i.ytimg.com')).toBe('https://www.youtube.com/')
    expect(platformForCoverHost('p3-sign.douyinpic.com')).toBe('douyin')
    expect(platformForCoverHost('ytimg.com.example.org')).toBeUndefined()
  })

  it('从平台分享文案中抽取短链', () => {
    const result = parseMediaInput('7.68 复制打开抖音，看看这个视频 https://v.douyin.com/abc123/ 复制此链接')
    expect(result).toEqual({
      ok: true,
      value: { platform: 'douyin', raw: 'https://v.douyin.com/abc123/', url: 'https://v.douyin.com/abc123/' },
    })
  })

  it.each(['7688917872717942059', '7699449302829059343'])('将抖音精选页 modal_id=%s 规范化为视频地址', (id) => {
    const result = parseMediaInput(`https://www.douyin.com/jingxuan?modal_id=${id}`)
    expect(result).toEqual({
      ok: true,
      value: {
        platform: 'douyin',
        raw: `https://www.douyin.com/video/${id}`,
        url: `https://www.douyin.com/video/${id}`,
      },
    })
  })

  it('抖音精选页的非法 modal_id 不会被改写', () => {
    const result = parseMediaInput('https://www.douyin.com/jingxuan?modal_id=not-a-video-id')
    expect(result).toEqual({
      ok: true,
      value: {
        platform: 'douyin',
        raw: 'https://www.douyin.com/jingxuan?modal_id=not-a-video-id',
        url: 'https://www.douyin.com/jingxuan?modal_id=not-a-video-id',
      },
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
      reason: '无法识别来源，支持B站、抖音、小红书、YouTube链接',
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
