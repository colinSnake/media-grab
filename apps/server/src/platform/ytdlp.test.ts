import { describe, expect, it, vi } from 'vitest'
import { access, readFile } from 'node:fs/promises'
import { ExtractorGate } from './extractor-gate.js'
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

  it('YouTube 登录提示指向 Cookie 设置，但不把验证失败断定为过期', async () => {
    const adapter = new YtDlpAdapter({
      platform: 'youtube',
      exec: async () => { throw new Error('ERROR: Sign in to confirm you’re not a bot: cookies are needed') },
    })
    await expect(adapter.parse('https://www.youtube.com/watch?v=example')).rejects.toMatchObject({
      code: 'MEDIA_COOKIE_REQUIRED',
      message: expect.stringContaining('平台设置'),
    })
    adapter.setCookieProvider(() => '# Netscape HTTP Cookie File\n.youtube.com\tTRUE\t/\tFALSE\t0\tSID\tsecret\n')
    await expect(adapter.parse('https://www.youtube.com/watch?v=example')).rejects.toMatchObject({
      code: 'MEDIA_COOKIE_REQUIRED',
      message: expect.stringContaining('也可能是 Cookie 失效'),
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

  it('小红书纯图文将 CDN thumbnails 转为可下载图片选项，不把视频封面当成图片', async () => {
    let extractorArgs: readonly string[] = []
    const adapter = new YtDlpAdapter({
      platform: 'xiaohongshu',
      exec: async (_file, args) => {
        extractorArgs = args
        return { stdout: JSON.stringify({
          id: 'photo-note', title: '图片笔记', formats: [],
          thumbnails: [
            { url: 'http://sns-webpic-qc.xhscdn.com/1/a.webp', width: 900, height: 1200 },
            { url: 'https://sns-webpic-qc.xhscdn.com/2/b.jpg', width: 900, height: 1200 },
            { url: 'https://example.com/untrusted.jpg' },
          ],
        }), stderr: '' }
      },
    })
    const result = await adapter.parse('https://www.xiaohongshu.com/explore/photo-note')
    expect(extractorArgs).toContain('--ignore-no-formats-error')
    expect(result.streams).toMatchObject([
      { id: 'image:1', kind: 'image', url: 'https://sns-webpic-qc.xhscdn.com/1/a.webp', label: '图片 1' },
      { id: 'image:2', kind: 'image', url: 'https://sns-webpic-qc.xhscdn.com/2/b.jpg', label: '图片 2' },
    ])
    expect(result.itemCount).toBe(2)
    expect(result.capabilities).toMatchObject({ video: false, image: true, download: true })
  })

  it('thumbnail 缺失时从最高分辨率 thumbnails 兜底取封面', async () => {
    const adapter = new YtDlpAdapter({
      platform: 'xiaohongshu',
      exec: async () => ({
        stdout: JSON.stringify({
          id: 'note-with-thumbnails',
          thumbnails: [
            { url: 'http://sns-webpic-qc.xhscdn.com/small.jpg', width: 480, height: 640 },
            { url: 'http://sns-webpic-qc.xhscdn.com/large.jpg', width: 1440, height: 1921 },
          ],
          formats: [],
        }),
        stderr: '',
      }),
    })

    const result = await adapter.parse('https://www.xiaohongshu.com/explore/note-with-thumbnails')

    expect(result.cover).toBe('https://sns-webpic-qc.xhscdn.com/large.jpg')
  })

  it('可将找不到可执行文件转换为明确的工具缺失错误', async () => {
    const adapter = new YtDlpAdapter({
      platform: 'xiaohongshu',
      exec: async (_file, _args, _options) => { throw new Error('spawn yt-dlp ENOENT') },
    })
    await expect(adapter.parse('https://www.xiaohongshu.com/explore/example')).rejects.toThrow('未找到 yt-dlp')
  })

  it('已配置 Cookie 且公开页也拒绝访问时，报告作品受限而非要求重贴 Cookie', async () => {
    const adapter = new YtDlpAdapter({
      platform: 'douyin',
      cookieProvider: () => '# Netscape HTTP Cookie File\n.douyin.com\tTRUE\t/\tFALSE\t0\tsessionid\tprivate\n',
      exec: async () => { throw new Error('ERROR: Fresh cookies (not necessarily logged in) are needed') },
      fetchImpl: (async () => new Response('', { status: 403 })) as typeof fetch,
      gate: new ExtractorGate(0),
    })
    await expect(adapter.parse('https://www.douyin.com/video/123')).rejects.toMatchObject({
      code: 'DOUYIN_PUBLIC_RESTRICTED',
      httpStatus: 403,
      message: expect.stringContaining('公开页拒绝访问'),
    })
  })

  it('没有 Cookie 且公开页拒绝访问时，也不误判为 Cookie 必需', async () => {
    const adapter = new YtDlpAdapter({
      platform: 'douyin',
      exec: async () => { throw new Error('ERROR: Fresh cookies (not necessarily logged in) are needed') },
      fetchImpl: (async () => new Response('', { status: 403 })) as typeof fetch,
      gate: new ExtractorGate(0),
    })
    await expect(adapter.parse('https://www.douyin.com/video/123')).rejects.toMatchObject({
      code: 'DOUYIN_PUBLIC_RESTRICTED',
      message: expect.stringContaining('公开页拒绝访问'),
    })
  })

  it.each([
    [429, 'PLATFORM_RATE_LIMITED'],
    [500, 'DOUYIN_PUBLIC_FETCH_FAILED'],
  ])('公开页返回 HTTP %i 时报告 %s，而不是要求重贴 Cookie', async (status, code) => {
    const adapter = new YtDlpAdapter({
      platform: 'douyin', gate: new ExtractorGate(0),
      exec: async () => { throw new Error('Fresh cookies are needed') },
      fetchImpl: (async () => new Response(null, { status })) as typeof fetch,
    })
    await expect(adapter.parse('https://www.douyin.com/video/123')).rejects.toMatchObject({ code })
  })

  it('公开页请求超时时报告网络故障；主动取消任务仍报告取消', async () => {
    const controller = new AbortController()
    const adapter = new YtDlpAdapter({
      platform: 'douyin', gate: new ExtractorGate(0),
      exec: async () => { throw new Error('Fresh cookies are needed') },
      fetchImpl: (async () => { throw new Error('connection timed out') }) as typeof fetch,
    })
    await expect(adapter.parse('https://www.douyin.com/video/123')).rejects.toMatchObject({ code: 'DOUYIN_PUBLIC_FETCH_FAILED' })
    controller.abort()
    await expect(adapter.parse('https://www.douyin.com/video/123', { signal: controller.signal })).rejects.toMatchObject({ code: 'TASK_CANCELLED' })
  })

  it('仅在抖音详情 403 时使用公开精选页兜底，并保留任务下载所需的规范化输入', async () => {
    const model = { video_duration: 12.5, video_list: [{
      main_url: 'https://v3.douyinvod.com/video.mp4',
      video_meta: { file_id: 'file-720', definition: '720p', vheight: 720, codec_type: 'h264', audio_channels: '2.0' },
    }] }
    const html = `<script>window._SSR_DATA = ${JSON.stringify({ data: { storeState: { detail: { videoData: { result: {
      gid: '123', title: '公开作品', video_model: JSON.stringify(model),
    } } } } } })};</script>`
    const fetchImpl = vi.fn(async () => new Response(html))
    const exec = vi.fn(async () => { throw new Error('Failed to download web detail JSON: HTTP Error 403: Fresh cookies are needed') })
    const adapter = new YtDlpAdapter({ platform: 'douyin', exec, fetchImpl: fetchImpl as typeof fetch, gate: new ExtractorGate(0) })

    const parsed = await adapter.parse('https://www.douyin.com/video/123')
    expect(parsed).toMatchObject({ id: '123', input: 'https://www.douyin.com/video/123', title: '公开作品',
      streams: [{ id: 'douyin-public:file-720', label: '720P', combined: true, url: 'https://v3.douyinvod.com/video.mp4' }] })
    expect(exec).toHaveBeenCalledOnce()
    expect(fetchImpl).toHaveBeenCalledOnce()

    const successful = new YtDlpAdapter({
      platform: 'douyin', fetchImpl: fetchImpl as typeof fetch,
      exec: async () => ({ stdout: JSON.stringify({ id: '123', formats: [] }), stderr: '' }),
    })
    await successful.parse('https://www.douyin.com/video/123')
    expect(fetchImpl).toHaveBeenCalledOnce()
  })

  it('把 extractor 限流映射为可重试风险错误', async () => {
    const adapter = new YtDlpAdapter({
      platform: 'xiaohongshu',
      exec: async () => { throw new Error('ERROR: HTTP Error 429: Too Many Requests') },
    })
    await expect(adapter.parse('https://www.xiaohongshu.com/explore/123')).rejects.toMatchObject({
      code: 'PLATFORM_RATE_LIMITED', kind: 'risk', httpStatus: 429, retryable: true,
    })
  })

  it('取消运行中的 extractor 时及时终止且不报为网络失败', async () => {
    const controller = new AbortController()
    const adapter = new YtDlpAdapter({
      platform: 'xiaohongshu',
      exec: async (_file, _args, options) => new Promise((_resolve, reject) => {
        options.signal?.addEventListener('abort', () => reject(new Error('The operation was aborted')), { once: true })
      }),
    })
    const result = adapter.parse('https://www.xiaohongshu.com/explore/123', { signal: controller.signal })
    await Promise.resolve()
    controller.abort()
    await expect(result).rejects.toMatchObject({ code: 'TASK_CANCELLED' })
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

  it('YouTube 解析使用保存的 Cookie 且销毁临时文件', async () => {
    let cookieFile = ''
    const adapter = new YtDlpAdapter({
      platform: 'youtube',
      cookieProvider: () => '# Netscape HTTP Cookie File\n#HttpOnly_.youtube.com\tTRUE\t/\tTRUE\t0\tSID\tsecret\n',
      exec: async (_file, args) => {
        cookieFile = String(args[args.indexOf('--cookies') + 1])
        expect(await readFile(cookieFile, 'utf8')).toContain('SID\tsecret')
        return { stdout: JSON.stringify({ id: 'video', formats: [] }), stderr: '' }
      },
    })
    await adapter.parse('https://www.youtube.com/watch?v=example')
    await expect(access(cookieFile)).rejects.toThrow()
  })
})
