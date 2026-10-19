import { describe, expect, it } from 'vitest'
import { YtDlpAdapter } from './ytdlp.js'

describe('YtDlpAdapter', () => {
  it('把 yt-dlp JSON formats 映射为通用媒体流', async () => {
    const adapter = new YtDlpAdapter({
      platform: 'douyin',
      exec: async (_file, _args, _options) => ({
        stdout: JSON.stringify({
          id: '123',
          title: 'demo',
          uploader: 'creator',
          thumbnail: 'http://cdn.example.com/cover.jpg',
          duration: 12.4,
          formats: [
            { format_id: 'video-720', url: 'https://cdn.example.com/video.mp4', vcodec: 'h264', acodec: 'none', height: 720, width: 1280, ext: 'mp4' },
            { format_id: 'audio-128', url: 'https://cdn.example.com/audio.m4a', vcodec: 'none', acodec: 'aac', tbr: 128, ext: 'm4a' },
          ],
        }),
        stderr: '',
      }) as never,
    })

    const result = await adapter.parse('https://v.douyin.com/example/')
    expect(result.platform).toBe('douyin')
    expect(result.title).toBe('demo')
    expect(result.authorName).toBe('creator')
    expect(result.cover).toBe('https://cdn.example.com/cover.jpg')
    expect(result.streams.map((stream) => stream.kind)).toEqual(['video', 'audio'])
    expect(result.capabilities.download).toBe(true)
  })

  it('可将找不到可执行文件转换为明确的工具缺失错误', async () => {
    const adapter = new YtDlpAdapter({
      platform: 'xiaohongshu',
      exec: async (_file, _args, _options) => { throw new Error('spawn yt-dlp ENOENT') },
    })
    await expect(adapter.parse('https://www.xiaohongshu.com/explore/example')).rejects.toThrow('未找到 yt-dlp')
  })

  it('把 yt-dlp 的 Unsupported URL 映射为不可重试的输入错误', async () => {
    const adapter = new YtDlpAdapter({
      platform: 'douyin',
      exec: async (_file, _args, _options) => { throw new Error('Command failed: ERROR: Unsupported URL') },
    })
    await expect(adapter.parse('https://v.douyin.com/expired/')).rejects.toMatchObject({
      code: 'UNSUPPORTED_MEDIA_URL',
      httpStatus: 422,
      kind: 'invalid',
    })
  })

  it('清理 stdout 前后的诊断文本后仍能读取 JSON', async () => {
    const adapter = new YtDlpAdapter({
      platform: 'douyin',
      exec: async (_file, _args, _options) => ({
        stdout: 'warning from wrapper\n{"id":"x","formats":[]}\n',
        stderr: '',
      }),
    })
    const result = await adapter.parse('https://v.douyin.com/example/')
    expect(result.id).toBe('x')
    expect(result.capabilities.download).toBe(false)
  })
})
