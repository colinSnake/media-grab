import { describe, expect, it, vi } from 'vitest'
import { parsePublicDouyinVideo } from './douyin-public.js'

const id = '7698196331776494888'
const mediaUrl = 'https://v3-qingtao.douyinvod.com/media.mp4?expires=private'
const backupUrl = 'https://v26-qingtao.douyinvod.com/media.mp4?expires=private'

function page(options: { gid?: string; url?: string; expires?: number; extraFormat?: boolean; silent?: boolean } = {}): string {
  const model = {
    video_duration: 216.688,
    url_expire: options.expires ?? Math.ceil(Date.now() / 1000) + 3600,
    video_list: [{
      main_url: options.url ?? mediaUrl,
      backup_url: backupUrl,
      video_meta: { file_id: 'original-file', definition: '720p', vwidth: 1280, vheight: 720, fps: 30, size: 12756384, bitrate: 1200000, codec_type: 'h264', audio_channels: options.silent ? '0' : '2.0', audio_bitrate_target: 64 },
    }, ...(options.extraFormat ? [{ main_url: 'https://v3-qingtao.douyinvod.com/high.mp4', video_meta: { file_id: 'high-file', definition: '1080p', vwidth: 1920, vheight: 1080, bitrate: 2400000 } }] : [])],
  }
  return `<html><script>window._SSR_DATA = ${JSON.stringify({ data: { storeState: { detail: { videoData: { result: {
    gid: options.gid ?? id, title: '公开作品', cover_image_url: 'https://p5.douyinpic.com/cover.jpg', media_user: { screen_name: '作者' }, video_model: JSON.stringify(model),
  } } } } } })};</script></html>`
}

describe('public Douyin video fallback', () => {
  it('parses the matching public video and maps playable formats without exposing cookies', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request) => new Response(page()))
    const parsed = await parsePublicDouyinVideo(`https://www.douyin.com/video/${id}`, fetchImpl as typeof fetch)

    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe(`https://jingxuan.douyin.com/m/video/${id}`)
    expect(parsed).toMatchObject({
      platform: 'douyin', input: `https://www.douyin.com/video/${id}`, id, title: '公开作品', authorName: '作者',
      cover: 'https://p5.douyinpic.com/cover.jpg', durationSec: 217,
      streams: [{ id: 'douyin-public:original-file', label: '720P 30fps', kind: 'video', combined: true, url: mediaUrl, backupUrls: [backupUrl],
        sizeBytes: 12756384, httpHeaders: { Referer: 'https://jingxuan.douyin.com/' } }],
      capabilities: { video: true, audio: true, download: true },
    })
    expect(JSON.stringify(parsed?.streams[0]?.httpHeaders)).not.toMatch(/cookie|authorization/i)
  })

  it('resolves only a Douyin short link redirect to a numeric video ID', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => String(url).includes('v.douyin.com')
      ? new Response(null, { status: 302, headers: { Location: `https://www.iesdouyin.com/share/video/${id}/?source=share` } })
      : new Response(page())) as unknown as typeof fetch
    expect((await parsePublicDouyinVideo('https://v.douyin.com/short/', fetchImpl))?.id).toBe(id)
    expect(fetchImpl).toHaveBeenCalledTimes(2)

    const foreignRedirect = vi.fn(async () => new Response(null, { status: 302, headers: { Location: 'https://example.com/video/123' } })) as unknown as typeof fetch
    expect(await parsePublicDouyinVideo('https://v.douyin.com/short/', foreignRedirect)).toBeUndefined()
    expect(foreignRedirect).toHaveBeenCalledTimes(1)
  })

  it('shows higher resolutions first without changing IDs used to refresh download URLs', async () => {
    const parsed = await parsePublicDouyinVideo(`https://www.douyin.com/video/${id}`, (async () => new Response(page({ extraFormat: true }))) as typeof fetch)
    expect(parsed?.streams.map(({ id: streamId, label }) => [streamId, label])).toEqual([
      ['douyin-public:high-file', '1080P'], ['douyin-public:original-file', '720P 30fps'],
    ])
  })

  it('does not offer audio when the public page reports no audio channels', async () => {
    const parsed = await parsePublicDouyinVideo(`https://www.douyin.com/video/${id}`, (async () => new Response(page({ silent: true }))) as typeof fetch)
    expect(parsed?.capabilities).toMatchObject({ video: true, audio: false, download: true })
    expect(parsed?.streams[0]?.combined).toBe(false)
  })

  it('rejects mismatched IDs, expired formats, foreign media hosts and non-video inputs', async () => {
    for (const html of [page({ gid: 'other' }), page({ expires: 1 }), page({ url: 'https://example.com/media.mp4', gid: id }).replace(backupUrl, 'http://evil.example/video')]) {
      const fetchImpl = vi.fn(async () => new Response(html)) as unknown as typeof fetch
      expect(await parsePublicDouyinVideo(`https://www.douyin.com/video/${id}`, fetchImpl)).toBeUndefined()
    }
    const fetchImpl = vi.fn() as unknown as typeof fetch
    expect(await parsePublicDouyinVideo('https://example.com/video/123', fetchImpl)).toBeUndefined()
    expect(await parsePublicDouyinVideo('https://www.douyin.com/jingxuan?modal_id=123', fetchImpl)).toBeUndefined()
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('rejects oversized pages without parsing or fetching arbitrary links', async () => {
    const fetchImpl = vi.fn(async () => new Response('unused', { headers: { 'content-length': '3000000' } })) as unknown as typeof fetch
    expect(await parsePublicDouyinVideo(`https://www.douyin.com/video/${id}`, fetchImpl)).toBeUndefined()
  })
})
