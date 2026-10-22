import { describe, expect, it } from 'vitest'
import { access, readFile } from 'node:fs/promises'
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

  it('解析 YouTube 格式并只保留下载所需的安全请求头', async () => {
    const adapter = new YtDlpAdapter({
      platform: 'youtube',
      exec: async () => ({
        stdout: JSON.stringify({
          id: 'dQw4w9WgXcQ',
          title: 'video',
          thumbnail: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg',
          formats: [{
            format_id: '18', url: 'https://rr.example/video.mp4', ext: 'mp4',
            vcodec: 'avc1', acodec: 'mp4a', height: 360,
            http_headers: {
              Referer: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
              'User-Agent': 'yt-dlp-agent',
              Cookie: 'secret=must-not-leak',
              Authorization: 'Bearer must-not-leak',
            },
          }],
        }),
        stderr: '',
      }),
    })

    const result = await adapter.parse('https://youtu.be/dQw4w9WgXcQ')
    expect(result.platform).toBe('youtube')
    expect(result.cover).toBe('https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg')
    expect(result.streams[0]).toMatchObject({
      kind: 'video',
      combined: true,
      httpHeaders: {
        Referer: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
        'User-Agent': 'yt-dlp-agent',
      },
    })
    expect(JSON.stringify(result.streams[0]?.httpHeaders)).not.toMatch(/secret|Authorization/i)
  })

  it('YouTube Cookie 错误不会指向尚不存在的平台 Cookie 设置', async () => {
    const adapter = new YtDlpAdapter({
      platform: 'youtube',
      exec: async () => { throw new Error('ERROR: Sign in to confirm you’re not a bot: cookies are needed') },
    })
    await expect(adapter.parse('https://www.youtube.com/watch?v=example')).rejects.toMatchObject({
      code: 'MEDIA_COOKIE_REQUIRED',
      message: expect.stringContaining('尚未支持'),
    })
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

  it('把抖音 Cookie 写入临时 Netscape 文件并在执行后清理', async () => {
    let cookiePath = ''
    let cookieContents = ''
    const adapter = new YtDlpAdapter({
      platform: 'douyin',
      cookieProvider: () => '# Netscape HTTP Cookie File\n.douyin.com\tTRUE\t/\tFALSE\t0\tsessionid\tsecret\n',
      exec: async (_file, args) => {
        const index = args.indexOf('--cookies')
        cookiePath = String(args[index + 1])
        cookieContents = await readFile(cookiePath, 'utf8')
        return { stdout: JSON.stringify({ id: 'x', formats: [] }), stderr: '' }
      },
    })

    await adapter.parse('https://www.douyin.com/video/123')
    expect(cookieContents).toContain('sessionid\tsecret')
    expect(cookiePath).toContain('mediagrab-ytdlp-')
    await expect(access(cookiePath)).rejects.toThrow()
  })

  it('小红书解析同样使用独立临时 Cookie 文件', async () => {
    let capturedArgs: readonly string[] = []
    let cookieFileContents = ''
    let cookiePath = ''
    const adapter = new YtDlpAdapter({
      platform: 'xiaohongshu',
      cookieProvider: () => '# Netscape HTTP Cookie File\n.xiaohongshu.com\tTRUE\t/\tFALSE\t0\tweb_session\tsecret\n',
      exec: async (_file, args) => {
        capturedArgs = args
        const index = args.indexOf('--cookies')
        cookiePath = String(args[index + 1])
        cookieFileContents = await readFile(cookiePath, 'utf8')
        return { stdout: JSON.stringify({ id: 'x', formats: [] }), stderr: '' }
      },
    })

    await adapter.parse('https://www.xiaohongshu.com/explore/example')
    expect(capturedArgs).toContain('--cookies')
    expect(cookieFileContents).toContain('web_session\tsecret')
    await expect(access(cookiePath)).rejects.toThrow()
  })
})
