import { describe, expect, it } from 'vitest'
import { resolveProjectYtDlp, YtDlpAdapter } from './ytdlp.js'

describe('YtDlpAdapter', () => {
  it('项目虚拟环境存在时可以解析其 yt-dlp 路径', () => {
    const executable = resolveProjectYtDlp()
    if (executable === undefined) return
    expect(executable).toMatch(/[\\/]\.venv[\\/](bin[\\/]yt-dlp|Scripts[\\/]yt-dlp\.exe)$/)
  })

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
    expect(result.streams[0]?.label).toBe('720P')
  })

  it('保留小红书合并音视频格式并规范化 CDN 封面为 HTTPS', async () => {
    const adapter = new YtDlpAdapter({
      platform: 'xiaohongshu',
      exec: async () => ({
        stdout: JSON.stringify({
          id: 'note-1',
          thumbnail: 'http://sns-webpic-qc.xhscdn.com/cover.jpg',
          duration: 57.6,
          formats: [{ format_id: '0', url: 'http://sns-video-v4.xhscdn.com/video.mp4', vcodec: 'h264', acodec: 'aac', width: 720, height: 1280, fps: 30 }],
        }),
        stderr: '',
      }),
    })

    const result = await adapter.parse('https://www.xiaohongshu.com/explore/note-1')

    expect(result.cover).toBe('https://sns-webpic-qc.xhscdn.com/cover.jpg')
    expect(result.streams[0]).toMatchObject({ kind: 'video', combined: true, label: '720P 30fps' })
    expect(result.capabilities).toMatchObject({ video: true, audio: true, download: true })
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

  it('把浏览器 Cookie 数据库不可读映射为明确的本地权限错误', async () => {
    const adapter = new YtDlpAdapter({
      platform: 'douyin',
      cookieBrowser: 'chrome',
      exec: async () => { throw new Error('Command failed: ERROR: could not find chrome cookies database in "/Users/test/Library/Application Support/Google/Chrome"') },
    })
    await expect(adapter.parse('https://v.douyin.com/example/')).rejects.toMatchObject({
      code: 'BROWSER_COOKIE_UNAVAILABLE',
      httpStatus: 403,
      kind: 'permission',
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

  it('仅在抖音显式配置时向 yt-dlp 传递浏览器 Cookie 来源', async () => {
    let capturedArgs: readonly string[] = []
    const adapter = new YtDlpAdapter({
      platform: 'douyin',
      cookieBrowser: 'chrome',
      exec: async (_file, args) => {
        capturedArgs = args
        return { stdout: JSON.stringify({ id: 'x', formats: [] }), stderr: '' }
      },
    })

    await adapter.parse('https://www.douyin.com/video/123')

    expect(capturedArgs).toContain('--cookies-from-browser')
    expect(capturedArgs).toContain('chrome')
  })

  it('默认不向 yt-dlp 请求读取浏览器 Cookie', async () => {
    let capturedArgs: readonly string[] = []
    const adapter = new YtDlpAdapter({
      platform: 'douyin',
      exec: async (_file, args) => {
        capturedArgs = args
        return { stdout: JSON.stringify({ id: 'x', formats: [] }), stderr: '' }
      },
    })

    await adapter.parse('https://www.douyin.com/video/123')

    expect(capturedArgs).not.toContain('--cookies-from-browser')
  })
})
