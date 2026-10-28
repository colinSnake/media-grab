import { access, mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { execFileSync, spawnSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { taskSnapshotSchema, type MediaParseResult, type TaskSnapshot } from '@mediagrab/shared'
import { TaskService } from './task-service.js'

class FakeTaskRepository {
  #tasks = new Map<string, TaskSnapshot>()

  list(): TaskSnapshot[] {
    return [...this.#tasks.values()].sort((a, b) => b.updatedAt - a.updatedAt)
  }

  get(id: string): TaskSnapshot | null {
    return this.#tasks.get(id) ?? null
  }

  save(task: TaskSnapshot): void {
    this.#tasks.set(task.id, task)
  }

  delete(id: string): void {
    this.#tasks.delete(id)
  }

  seed(task: TaskSnapshot): void {
    this.#tasks.set(task.id, task)
  }
}

function service(options: { media?: MediaParseResult } = {}): TaskService {
  const repo = new FakeTaskRepository()
  const media = options.media
  return new TaskService({
    repo: repo as never,
    platforms: {} as never,
    media: { parse: async () => media } as never,
    config: { get: () => ({ ffmpegPath: '', savePath: './download', audioBitrateKbps: 128, downloadPoolSize: 3 }) } as never,
    fetchImpl: (async () => new Response(null, { status: 200 })) as typeof fetch,
  })
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('等待任务完成超时')
}

describe('TaskService task identity', () => {
  it('records transfer statistics only after an explicit start and clears them on retry', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'mediagrab-download-stats-'))
    const repo = new FakeTaskRepository()
    const media: MediaParseResult = {
      platform: 'douyin', input: 'https://example.com/video/stats', id: 'stats', title: 'stats', authorName: '', cover: '', durationSec: 1,
      streams: [{ id: 'video', kind: 'video', combined: false, label: '720P', url: 'https://example.com/stream', backupUrls: [], available: true, reason: '' }],
      itemCount: 1, capabilities: { video: true, audio: false, image: false, download: true },
    }
    let releaseRetry!: () => void
    const retryGate = new Promise<void>((resolve) => { releaseRetry = resolve })
    const fetchImpl = vi.fn(async () => {
      if (fetchImpl.mock.calls.length > 1) await retryGate
      const body = new ReadableStream<Uint8Array>({
        async start(controller) {
          await new Promise((resolve) => setTimeout(resolve, 12))
          controller.enqueue(new Uint8Array([1, 2, 3]))
          controller.close()
        },
      })
      return new Response(body, { headers: { 'content-length': '3' } })
    })
    const options = {
      repo: repo as never, platforms: {} as never, media: { parse: async () => media } as never,
      config: { get: () => ({ ffmpegPath: '', savePath: root, downloadPoolSize: 1 }) } as never,
      dataDir: root, fetchImpl: fetchImpl as typeof fetch,
    }
    try {
      const service = new TaskService(options)
      const { task } = await service.create({ start: false, platform: 'douyin', input: media.input, mode: 'video', title: media.title })
      expect(service.get(task.id)).toMatchObject({ status: 'queued', downloadedBytes: 0, transferDurationMs: 0 })
      expect(fetchImpl).not.toHaveBeenCalled()

      const restarted = new TaskService(options)
      expect(restarted.get(task.id)?.status).toBe('queued')
      expect(fetchImpl).not.toHaveBeenCalled()
      expect(restarted.start(task.id)?.status).toBe('waiting')
      await waitFor(() => restarted.get(task.id)?.status === 'success')
      const finished = taskSnapshotSchema.parse(JSON.parse(JSON.stringify(restarted.get(task.id))))
      expect(finished).toMatchObject({ status: 'success', totalBytes: 3, downloadedBytes: 3, speedBps: 0 })
      expect(finished.transferDurationMs).toBeGreaterThan(0)
      expect(fetchImpl).toHaveBeenCalledTimes(1)

      expect(restarted.retry(task.id)).toMatchObject({ status: 'waiting', downloadedBytes: 0, transferDurationMs: 0 })
      releaseRetry()
      await waitFor(() => restarted.get(task.id)?.status === 'success')
      expect(restarted.get(task.id)?.downloadedBytes).toBe(3)
      expect(fetchImpl).toHaveBeenCalledTimes(2)
    } finally {
      releaseRetry()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('does not drop an immediate retry requested as soon as success is persisted', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'mediagrab-immediate-retry-'))
    const repo = new FakeTaskRepository()
    const media: MediaParseResult = {
      platform: 'douyin', input: 'https://example.com/video/immediate-retry', id: 'immediate-retry', title: 'retry', authorName: '', cover: '', durationSec: 1,
      streams: [{ id: 'video', kind: 'video', combined: false, label: '720P', url: 'https://example.com/stream', backupUrls: [], available: true, reason: '' }],
      itemCount: 1, capabilities: { video: true, audio: false, image: false, download: true },
    }
    const fetchImpl = vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-length': '3' } }))
    const taskService = new TaskService({
      repo: repo as never, platforms: {} as never, media: { parse: async () => media } as never,
      config: { get: () => ({ ffmpegPath: '', savePath: root, downloadPoolSize: 1 }) } as never,
      dataDir: root, fetchImpl: fetchImpl as typeof fetch,
    })
    let retryRequested = false
    const unsubscribe = taskService.subscribe((event) => {
      if (event.type !== 'task-update' || event.task.status !== 'success' || retryRequested) return
      retryRequested = true
      taskService.retry(event.task.id)
    })
    try {
      const { task } = await taskService.create({ start: false, platform: 'douyin', input: media.input, mode: 'video', title: media.title })
      taskService.start(task.id)
      await waitFor(() => taskService.get(task.id)?.status === 'success' && fetchImpl.mock.calls.length === 2)
      expect(retryRequested).toBe(true)
      expect(fetchImpl).toHaveBeenCalledTimes(2)
    } finally {
      unsubscribe()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('retains partial transfer statistics when a stream fails', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'mediagrab-partial-stats-'))
    const repo = new FakeTaskRepository()
    const media: MediaParseResult = {
      platform: 'douyin', input: 'https://example.com/video/partial', id: 'partial', title: 'partial', authorName: '', cover: '', durationSec: 1,
      streams: [{ id: 'video', kind: 'video', combined: false, label: '720P', url: 'https://example.com/stream', backupUrls: [], available: true, reason: '' }],
      itemCount: 1, capabilities: { video: true, audio: false, image: false, download: true },
    }
    const taskService = new TaskService({
      repo: repo as never, platforms: {} as never, media: { parse: async () => media } as never,
      config: { get: () => ({ ffmpegPath: '', savePath: root, downloadPoolSize: 1 }) } as never,
      dataDir: root,
      fetchImpl: (async () => new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([1, 2, 3]))
          setTimeout(() => controller.error(new Error('connection lost')), 12)
        },
      }), { headers: { 'content-length': '6' } })) as typeof fetch,
    })
    try {
      const { task } = await taskService.create({ start: false, platform: 'douyin', input: media.input, mode: 'video', title: media.title })
      taskService.start(task.id)
      await waitFor(() => taskService.get(task.id)?.status === 'fail')
      expect(taskService.get(task.id)).toMatchObject({ status: 'fail', downloadedBytes: 3, totalBytes: 6, speedBps: 0 })
      expect(taskService.get(task.id)?.transferDurationMs).toBeGreaterThan(0)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('keeps an explicitly queued task idle until start, including after a restart', async () => {
    const repo = new FakeTaskRepository()
    const options = {
      repo: repo as never,
      platforms: {} as never,
      media: {} as never,
      config: { get: () => ({ ffmpegPath: '', savePath: './download', downloadPoolSize: 1 }) } as never,
      fetchImpl: fetch,
    }
    const taskService = new TaskService(options)
    const { task } = await taskService.create({ start: false, platform: 'bilibili', bvid: 'BV1GJ411x7h7', cid: 1, mode: 'video', title: 'queued' })
    expect(taskService.get(task.id)?.status).toBe('queued')
    await expect(taskService.create({ start: false, platform: 'bilibili', bvid: 'BV1GJ411x7h7', cid: 1, mode: 'video', title: 'queued' })).resolves.toMatchObject({ deduplicated: true })

    const restarted = new TaskService(options)
    expect(restarted.get(task.id)?.status).toBe('queued')
    expect(restarted.start(task.id)?.status).toBe('waiting')
    expect(restarted.start(task.id)?.status).not.toBe('queued')
    expect(restarted.start('missing')).toBeNull()
  })

  it('rejects a task whose declared platform conflicts with a recognized URL', async () => {
    const taskService = service({ media: {
      platform: 'douyin', input: 'https://www.douyin.com/video/1', id: '1', title: 'test', authorName: '', cover: '', durationSec: 1,
      streams: [], itemCount: 1, capabilities: { video: false, audio: false, image: false, download: false },
    } })

    await expect(taskService.create({ platform: 'youtube', input: 'https://www.douyin.com/video/1', mode: 'video', title: '' })).rejects.toMatchObject({
      code: 'INVALID_TASK',
    })
  })

  it('infers the platform when a task request omits it', async () => {
    const taskService = service({ media: {
      platform: 'douyin', input: 'https://www.douyin.com/video/1', id: '1', title: 'test', authorName: '', cover: '', durationSec: 1,
      streams: [{ id: 'video', kind: 'video', combined: true, label: '720P', url: 'https://example.com/video', backupUrls: [], available: true, reason: '' }],
      itemCount: 1, capabilities: { video: true, audio: true, image: false, download: true },
    } })

    const result = await taskService.create({ input: 'https://www.douyin.com/video/1', mode: 'video', title: '' })
    expect(result.task.platform).toBe('douyin')
  })

  it('serializes concurrent duplicate creates', async () => {
    const taskService = service()
    const request = {
      platform: 'bilibili' as const,
      bvid: 'BV1GJ411x7h7',
      cid: 1,
      qn: 64,
      mode: 'video+audio' as const,
      audioContainer: 'mp3' as const,
      title: 'test',
    }

    const [first, second] = await Promise.all([taskService.create(request), taskService.create(request)])

    expect(first.deduplicated).toBe(false)
    expect(second.deduplicated).toBe(true)
    expect(second.task.id).toBe(first.task.id)
  })

  it('normalizes a generic video-plus-audio task to a video stream', async () => {
    const media = {
      platform: 'douyin',
      input: 'https://example.com/video/1',
      id: 'video-1',
      title: 'test',
      authorName: '',
      cover: '',
      durationSec: 1,
      streams: [
        { id: 'video-1', kind: 'video', combined: false, label: '720P 30fps', url: 'https://example.com/video', backupUrls: [], available: true, reason: '' },
        { id: 'audio-1', kind: 'audio', combined: false, label: '128k', url: 'https://example.com/audio', backupUrls: [], available: true, reason: '' },
      ],
      itemCount: 1,
      capabilities: { video: true, audio: true, image: false, download: true },
    } as MediaParseResult
    const taskService = service({ media })

    const result = await taskService.create({
      platform: 'douyin',
      input: media.input,
      streamId: 'audio-1',
      mode: 'video+audio',
      audioContainer: 'm4a',
      title: media.title,
    })

    expect(result.task.streamId).toBe('video-1')
    expect(result.task.qualityLabel).toBe('720P 30fps')
  })

  it('skips unavailable generic streams when the request selects one', async () => {
    const media: MediaParseResult = {
      platform: 'douyin', input: 'https://example.com/video/unavailable', id: 'unavailable', title: 'test', authorName: '', cover: '', durationSec: 1,
      streams: [
        { id: 'restricted', kind: 'video', combined: true, label: '1080P', url: 'https://example.com/restricted', backupUrls: [], available: false, reason: '需要登录' },
        { id: 'available', kind: 'video', combined: true, label: '720P', url: 'https://example.com/available', backupUrls: [], available: true, reason: '' },
      ],
      itemCount: 1, capabilities: { video: true, audio: true, image: false, download: true },
    }
    const result = await service({ media }).create({ platform: 'douyin', input: media.input, streamId: 'restricted', mode: 'video', title: media.title })
    expect(result.task.streamId).toBe('available')
    expect(result.task.qualityLabel).toBe('720P')
  })

  it('keeps a selected public Douyin format or fails instead of switching to a yt-dlp format', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'mediagrab-format-switch-'))
    const repo = new FakeTaskRepository()
    const selected: MediaParseResult['streams'][number] = {
      id: 'douyin-public:chosen', kind: 'video', combined: true, label: '1080P',
      url: 'https://v3.douyinvod.com/chosen.mp4', backupUrls: [], available: true, reason: '',
    }
    const parsed: MediaParseResult = {
      platform: 'douyin', input: 'https://www.douyin.com/video/123', id: '123', title: 'clip', authorName: '', cover: '', durationSec: 1,
      streams: [selected], itemCount: 1, capabilities: { video: true, audio: true, image: false, download: true },
    }
    const taskService = new TaskService({
      repo: repo as never, platforms: {} as never,
      media: { parse: async () => parsed, streamsForDownload: async () => [{ ...selected, id: 'yt-dlp-other', label: '720P' }] } as never,
      config: { get: () => ({ ffmpegPath: '', savePath: root, audioBitrateKbps: 128, downloadPoolSize: 1 }) } as never,
      dataDir: root,
      fetchImpl: (async () => { throw new Error('Unexpected download') }) as typeof fetch,
    })
    try {
      await expect(taskService.create({ platform: 'douyin', input: parsed.input, streamId: 'douyin-public:missing', mode: 'video', title: '' }))
        .rejects.toMatchObject({ code: 'SELECTED_STREAM_UNAVAILABLE' })
      await expect(taskService.create({ platform: 'douyin', input: parsed.input, streamId: 'a'.repeat(32), mode: 'video', title: '' }))
        .rejects.toMatchObject({ code: 'SELECTED_STREAM_UNAVAILABLE' })
      const { task } = await taskService.create({ platform: 'douyin', input: parsed.input, streamId: selected.id, mode: 'video', title: '' })
      await waitFor(() => taskService.get(task.id)?.status === 'fail')
      expect(taskService.get(task.id)).toMatchObject({ streamId: selected.id, error: '所选抖音清晰度已变化，请重新解析并创建任务' })

      const audio = await taskService.create({ platform: 'douyin', input: parsed.input, streamId: selected.id, mode: 'audio', title: '' })
      expect(audio.task.streamId).toBe(selected.id)
      await waitFor(() => taskService.get(audio.task.id)?.status === 'fail')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('does not accept photo mode on a video-only platform', async () => {
    const taskService = service()
    await expect(taskService.create({ platform: 'bilibili', bvid: 'BV1GJ411x7h7', cid: 1, mode: 'image', title: '' })).rejects.toMatchObject({ code: 'INVALID_TASK' })
  })

  it('saves a selected Xiaohongshu photo as an image without FFmpeg or overwriting another photo', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'mediagrab-photo-'))
    const repo = new FakeTaskRepository()
    const media: MediaParseResult = {
      platform: 'xiaohongshu', input: 'https://www.xiaohongshu.com/explore/123', id: '123', title: 'album',
      authorName: '', cover: '', durationSec: 0, itemCount: 2,
      streams: [
        { id: 'image:1', kind: 'image', combined: false, label: '图片 1', url: 'https://sns-webpic-qc.xhscdn.com/a', backupUrls: [], available: true, reason: '' },
        { id: 'image:2', kind: 'image', combined: false, label: '图片 2', url: 'https://sns-webpic-qc.xhscdn.com/b', backupUrls: [], available: true, reason: '' },
      ], capabilities: { video: false, audio: false, image: true, download: true },
    }
    const taskService = new TaskService({
      repo: repo as never, platforms: {} as never,
      media: { parse: async () => media } as never,
      config: { get: () => ({ ffmpegPath: '/no-ffmpeg', savePath: root, downloadPoolSize: 1 }) } as never,
      dataDir: root,
      fetchImpl: (async () => new Response(new Uint8Array([0x52, 0x49, 0x46, 0x46]), {
        status: 200, headers: { 'content-type': 'image/webp', 'content-length': '4' },
      })) as typeof fetch,
    })
    try {
      const first = await taskService.create({ platform: 'xiaohongshu', input: media.input, mode: 'image', streamId: 'image:1', title: '' })
      const second = await taskService.create({ platform: 'xiaohongshu', input: media.input, mode: 'image', streamId: 'image:2', title: '' })
      await waitFor(() => taskService.get(first.task.id)?.status === 'success' && taskService.get(second.task.id)?.status === 'success')
      const firstName = taskService.get(first.task.id)?.fileName ?? ''
      const secondName = taskService.get(second.task.id)?.fileName ?? ''
      expect(firstName).toBe('album-123-image 1.webp')
      expect(secondName).toBe('album-123-image 2.webp')
      expect(taskService.get(first.task.id)?.outputDir).toBe(root)
      expect(await readFile(path.join(root, firstName))).toEqual(await readFile(path.join(root, secondName)))
      expect(taskService.get(first.task.id)?.phase).toBe('done')
      await rm(path.join(root, firstName))
      const retried = taskService.retry(first.task.id)
      expect(retried).toMatchObject({ fileName: '', files: [], status: 'waiting' })
      await waitFor(() => taskService.get(first.task.id)?.status === 'success')
      expect(await readFile(path.join(root, firstName))).toEqual(await readFile(path.join(root, secondName)))
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('limits running downloads to downloadPoolSize and drains queued tasks', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'mediaGrab-pool-'))
    const repo = new FakeTaskRepository()
    let runningFetches = 0
    let maxRunningFetches = 0
    const media = (input: string): MediaParseResult => ({
      platform: 'douyin',
      input,
      id: input,
      title: input.endsWith('1') ? 'pool-one' : 'pool-two',
      authorName: '',
      cover: '',
      durationSec: 1,
      streams: [{ id: 'video-only', kind: 'video', combined: false, label: '720P', url: 'https://example.com/video', backupUrls: [], available: true, reason: '' }],
      itemCount: 1,
      capabilities: { video: true, audio: true, image: false, download: true },
    })
    const taskService = new TaskService({
      repo: repo as never,
      platforms: {} as never,
      media: { parse: async (input: string) => media(input) } as never,
      config: { get: () => ({ ffmpegPath: '', savePath: root, audioBitrateKbps: 128, downloadPoolSize: 1 }) } as never,
      fetchImpl: (async () => {
        runningFetches += 1
        maxRunningFetches = Math.max(maxRunningFetches, runningFetches)
        await new Promise((resolve) => setTimeout(resolve, 30))
        runningFetches -= 1
        return new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'content-length': '3' } })
      }) as typeof fetch,
    })

    try {
      const first = await taskService.create({ platform: 'douyin', input: 'https://example.com/video/1', mode: 'video', title: '' })
      const second = await taskService.create({ platform: 'douyin', input: 'https://example.com/video/2', mode: 'video', title: '' })

      expect(taskService.get(second.task.id)?.status).toBe('waiting')
      await waitFor(() => taskService.get(first.task.id)?.status === 'success' && taskService.get(second.task.id)?.status === 'success')
      expect(maxRunningFetches).toBe(1)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('starts queued tasks immediately when the configured pool size increases', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'mediaGrab-pool-update-'))
    const repo = new FakeTaskRepository()
    let poolSize = 1
    let notifyStarted!: () => void
    const bothStarted = new Promise<void>((resolve) => { notifyStarted = resolve })
    let startedCount = 0
    let releaseFetches!: () => void
    const fetchGate = new Promise<void>((resolve) => { releaseFetches = resolve })
    const media = (input: string): MediaParseResult => ({
      platform: 'douyin', input, id: input, title: input.endsWith('1') ? 'update-one' : 'update-two',
      authorName: '', cover: '', durationSec: 1,
      streams: [{ id: 'combined', kind: 'video', combined: true, label: '720P', url: 'https://example.com/video', backupUrls: [], available: true, reason: '' }],
      itemCount: 1, capabilities: { video: true, audio: true, image: false, download: true },
    })
    const taskService = new TaskService({
      repo: repo as never,
      platforms: {} as never,
      media: { parse: async (input: string) => media(input) } as never,
      config: { get: () => ({ ffmpegPath: '', savePath: root, audioBitrateKbps: 128, downloadPoolSize: poolSize }) } as never,
      dataDir: root,
      fetchImpl: (async () => {
        startedCount += 1
        if (startedCount === 2) notifyStarted()
        await fetchGate
        return new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'content-length': '3' } })
      }) as typeof fetch,
    })

    try {
      const first = await taskService.create({ platform: 'douyin', input: 'https://example.com/video/1', mode: 'video+audio', audioContainer: 'm4a', title: '' })
      const second = await taskService.create({ platform: 'douyin', input: 'https://example.com/video/2', mode: 'video+audio', audioContainer: 'm4a', title: '' })
      expect(taskService.get(second.task.id)?.status).toBe('waiting')
      poolSize = 2
      taskService.configChanged()
      await bothStarted
      expect(startedCount).toBe(2)
    } finally {
      releaseFetches()
      await waitFor(() => repo.list().every((task) => task.status === 'success' || task.status === 'fail'))
      await rm(root, { recursive: true, force: true })
    }
  })

  it('adds video and audio content lengths to the aggregate progress total', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'mediaGrab-progress-'))
    const repo = new FakeTaskRepository()
    const media: MediaParseResult = {
      platform: 'douyin',
      input: 'https://example.com/video/progress',
      id: 'progress',
      title: 'progress-test',
      authorName: '',
      cover: '',
      durationSec: 1,
      streams: [
        { id: 'video', kind: 'video', combined: false, label: '720P', url: 'https://example.com/video', backupUrls: [], available: true, reason: '' },
        { id: 'audio', kind: 'audio', combined: false, label: '128K', url: 'https://example.com/audio', backupUrls: [], available: true, reason: '' },
      ],
      itemCount: 1,
      capabilities: { video: true, audio: true, image: false, download: true },
    }
    const taskService = new TaskService({
      repo: repo as never,
      platforms: {} as never,
      media: { parse: async () => media } as never,
      config: { get: () => ({ ffmpegPath: '', savePath: root, audioBitrateKbps: 128, downloadPoolSize: 1 }) } as never,
      dataDir: root,
      fetchImpl: (async (input) => {
        const audio = String(input).endsWith('/audio')
        const bytes = new Uint8Array(audio ? [1, 2, 3] : [4, 5, 6, 7, 8])
        return new Response(bytes, { status: 200, headers: { 'content-length': String(bytes.byteLength) } })
      }) as typeof fetch,
    })

    try {
      const result = await taskService.create({ platform: 'douyin', input: media.input, mode: 'video+audio', audioContainer: 'm4a', title: media.title })
      await waitFor(() => {
        const status = taskService.get(result.task.id)?.status
        return status === 'success' || status === 'fail'
      })
      expect(taskService.get(result.task.id)).toMatchObject({ totalBytes: 8, downloadedBytes: 8 })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('cancels a running task and removes its temporary task directory', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'mediaGrab-cancel-'))
    const repo = new FakeTaskRepository()
    const media: MediaParseResult = {
      platform: 'douyin',
      input: 'https://example.com/video/cancel',
      id: 'cancel',
      title: 'cancel-test',
      authorName: '',
      cover: '',
      durationSec: 1,
      streams: [{ id: 'combined', kind: 'video', combined: true, label: '720P', url: 'https://example.com/video', backupUrls: [], available: true, reason: '' }],
      itemCount: 1,
      capabilities: { video: true, audio: true, image: false, download: true },
    }
    let notifyFetchStarted!: () => void
    const fetchStarted = new Promise<void>((resolve) => { notifyFetchStarted = resolve })
    const taskService = new TaskService({
      repo: repo as never,
      platforms: {} as never,
      media: { parse: async () => media } as never,
      config: { get: () => ({ ffmpegPath: '', savePath: root, audioBitrateKbps: 128, downloadPoolSize: 1 }) } as never,
      dataDir: root,
      fetchImpl: ((_input, init) => new Promise((_resolve, reject) => {
        const signal = init?.signal
        notifyFetchStarted()
        signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      })) as typeof fetch,
    })

    try {
      const result = await taskService.create({ platform: 'douyin', input: media.input, mode: 'video+audio', audioContainer: 'm4a', title: media.title })
      await fetchStarted
      taskService.cancel(result.task.id)
      await waitFor(() => taskService.get(result.task.id)?.status === 'stopped')
      await expect(access(path.join(root, 'tasks', result.task.id))).rejects.toThrow()
      expect(await readdir(root)).not.toContain('.cancel-test.mp4.' + result.task.id + '.tmp')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('deletes a running queue task only after its download has stopped and cleaned up', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'mediaGrab-remove-running-'))
    const repo = new FakeTaskRepository()
    const media: MediaParseResult = {
      platform: 'douyin', input: 'https://example.com/video/remove', id: 'remove', title: 'remove-test', authorName: '', cover: '', durationSec: 1,
      streams: [{ id: 'combined', kind: 'video', combined: true, label: '720P', url: 'https://example.com/video', backupUrls: [], available: true, reason: '' }],
      itemCount: 1, capabilities: { video: true, audio: true, image: false, download: true },
    }
    let notifyFetchStarted!: () => void
    const fetchStarted = new Promise<void>((resolve) => { notifyFetchStarted = resolve })
    const taskService = new TaskService({
      repo: repo as never,
      platforms: {} as never,
      media: { parse: async () => media } as never,
      config: { get: () => ({ ffmpegPath: '', savePath: root, audioBitrateKbps: 128, downloadPoolSize: 1 }) } as never,
      dataDir: root,
      fetchImpl: ((_input, init) => new Promise((_resolve, reject) => {
        notifyFetchStarted()
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      })) as typeof fetch,
    })
    const events: string[] = []
    taskService.subscribe((event) => { if ('id' in event) events.push(event.type) })

    try {
      const { task } = await taskService.create({ platform: 'douyin', input: media.input, mode: 'video', title: media.title })
      await fetchStarted
      expect(await taskService.remove(task.id)).toBe(true)
      expect(taskService.get(task.id)).toBeNull()
      await expect(access(path.join(root, 'tasks', task.id))).rejects.toThrow()
      expect(events.at(-1)).toBe('task-removed')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('deletes a queued task without starting its download', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'mediaGrab-remove-queued-'))
    const repo = new FakeTaskRepository()
    const media = (input: string): MediaParseResult => ({
      platform: 'douyin', input, id: input.split('/').at(-1) ?? '', title: 'queued-test', authorName: '', cover: '', durationSec: 1,
      streams: [{ id: 'combined', kind: 'video', combined: true, label: '720P', url: 'https://example.com/video', backupUrls: [], available: true, reason: '' }],
      itemCount: 1, capabilities: { video: true, audio: true, image: false, download: true },
    })
    let notifyFetchStarted!: () => void
    const fetchStarted = new Promise<void>((resolve) => { notifyFetchStarted = resolve })
    let fetchCount = 0
    const taskService = new TaskService({
      repo: repo as never,
      platforms: {} as never,
      media: { parse: async (input: string) => media(input) } as never,
      config: { get: () => ({ ffmpegPath: '', savePath: root, audioBitrateKbps: 128, downloadPoolSize: 1 }) } as never,
      dataDir: root,
      fetchImpl: ((_input, init) => new Promise((_resolve, reject) => {
        fetchCount += 1
        notifyFetchStarted()
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      })) as typeof fetch,
    })

    try {
      const first = await taskService.create({ platform: 'douyin', input: 'https://example.com/video/first', mode: 'video', title: 'first' })
      await fetchStarted
      const second = await taskService.create({ platform: 'douyin', input: 'https://example.com/video/second', mode: 'video', title: 'second' })
      expect(taskService.get(second.task.id)?.status).toBe('waiting')
      expect(await taskService.remove(second.task.id)).toBe(true)
      expect(taskService.get(second.task.id)).toBeNull()
      expect(fetchCount).toBe(1)
      await taskService.remove(first.task.id)
      expect(fetchCount).toBe(1)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('falls back to an alternate stream URL when the primary URL fails', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'mediaGrab-fallback-'))
    const repo = new FakeTaskRepository()
    const media: MediaParseResult = {
      platform: 'douyin', input: 'https://example.com/video/fallback', id: 'fallback', title: 'fallback-test', authorName: '', cover: '', durationSec: 1,
      streams: [{ id: 'video', kind: 'video', combined: false, label: '720P', url: 'https://example.com/primary', backupUrls: ['https://example.com/backup'], available: true, reason: '' }],
      itemCount: 1, capabilities: { video: true, audio: true, image: false, download: true },
    }
    const attempted: string[] = []
    const taskService = new TaskService({
      repo: repo as never,
      platforms: {} as never,
      media: { parse: async () => media } as never,
      config: { get: () => ({ ffmpegPath: '', savePath: root, audioBitrateKbps: 128, downloadPoolSize: 1 }) } as never,
      dataDir: root,
      fetchImpl: (async (input) => {
        attempted.push(String(input))
        if (String(input).endsWith('/primary')) return new Response(null, { status: 503 })
        return new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'content-length': '3' } })
      }) as typeof fetch,
    })

    try {
      const result = await taskService.create({ platform: 'douyin', input: media.input, mode: 'video', title: media.title })
      await waitFor(() => taskService.get(result.task.id)?.status === 'success' || taskService.get(result.task.id)?.status === 'fail')
      expect(taskService.get(result.task.id)?.status).toBe('success')
      expect(attempted).toEqual(['https://example.com/primary', 'https://example.com/backup'])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it.skipIf(spawnSync('ffmpeg', ['-version']).status !== 0 || spawnSync('ffprobe', ['-version']).status !== 0)('extracts Xiaohongshu audio and saves two separate files in video+audio mode', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'mediagrab-audio-'))
    const fixture = path.join(root, 'source.mp4')
    const repo = new FakeTaskRepository()
    try {
      execFileSync('ffmpeg', ['-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=64x64:r=5:d=1', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-c:v', 'mpeg4', '-c:a', 'aac', '-shortest', '-y', fixture])
      const bytes = await readFile(fixture)
      const media: MediaParseResult = {
        platform: 'xiaohongshu', input: 'https://www.xiaohongshu.com/explore/6ad1ead3000000000a023a12', id: '6ad1ead3000000000a023a12', title: 'clip', authorName: '', cover: '', durationSec: 1,
        streams: [{ id: '0', kind: 'video', combined: false, label: '720P', url: 'https://example.com/clip.mp4', backupUrls: [], available: true, reason: '' }],
        itemCount: 1, capabilities: { video: true, audio: false, image: false, download: true },
      }
      const taskService = new TaskService({
        repo: repo as never, platforms: {} as never, media: { parse: async () => media } as never,
        config: { get: () => ({ ffmpegPath: '', savePath: root, audioBitrateKbps: 128, downloadPoolSize: 1 }) } as never,
        dataDir: root,
        fetchImpl: (async () => new Response(bytes, { status: 200, headers: { 'content-length': String(bytes.length) } })) as typeof fetch,
      })
      const probe = (name: string) => execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', path.join(root, name)], { encoding: 'utf8' }).trim().split('\n')

      const audioTask = await taskService.create({ platform: 'xiaohongshu', input: media.input, mode: 'audio', audioContainer: 'm4a', title: media.title })
      await waitFor(() => ['success', 'fail'].includes(taskService.get(audioTask.task.id)?.status ?? ''))
      expect(taskService.get(audioTask.task.id)?.error).toBe('')
      expect(taskService.get(audioTask.task.id)).toMatchObject({ status: 'success', files: [{ kind: 'audio', fileName: 'clip.m4a' }] })
      expect(probe('clip.m4a')).toEqual(['audio'])

      const mp3Task = await taskService.create({ platform: 'xiaohongshu', input: media.input, mode: 'audio', audioContainer: 'mp3', title: media.title })
      await waitFor(() => ['success', 'fail'].includes(taskService.get(mp3Task.task.id)?.status ?? ''))
      expect(taskService.get(mp3Task.task.id)).toMatchObject({ status: 'success', files: [{ kind: 'audio', fileName: 'clip.mp3' }] })
      expect(probe('clip.mp3')).toEqual(['audio'])

      const pairTask = await taskService.create({ platform: 'xiaohongshu', input: media.input, mode: 'video+audio', title: media.title })
      await waitFor(() => ['success', 'fail'].includes(taskService.get(pairTask.task.id)?.status ?? ''))
      expect(taskService.get(pairTask.task.id)).toMatchObject({ status: 'success', files: [{ kind: 'video', fileName: 'clip-video.mp4' }, { kind: 'audio', fileName: 'clip-audio.m4a' }] })
      expect(probe('clip-video.mp4')).toEqual(['video', 'audio'])
      expect(probe('clip-audio.m4a')).toEqual(['audio'])

      const videoTask = await taskService.create({ platform: 'xiaohongshu', input: media.input, mode: 'video', title: media.title })
      await waitFor(() => ['success', 'fail'].includes(taskService.get(videoTask.task.id)?.status ?? ''))
      expect(taskService.get(videoTask.task.id)?.status).toBe('success')
      expect(probe('clip.mp4')).toEqual(['video'])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it.skipIf(spawnSync('ffmpeg', ['-version']).status !== 0 || spawnSync('ffprobe', ['-version']).status !== 0)('muxes separate video and audio streams into a voiced video and a standalone audio file', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'mediaGrab-mux-'))
    const videoFixture = path.join(root, 'video-only.mp4')
    const audioFixture = path.join(root, 'audio-only.m4a')
    const repo = new FakeTaskRepository()
    try {
      execFileSync('ffmpeg', ['-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=64x64:r=5:d=1', '-an', '-c:v', 'mpeg4', '-y', videoFixture])
      execFileSync('ffmpeg', ['-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-vn', '-c:a', 'aac', '-y', audioFixture])
      const videoBytes = await readFile(videoFixture)
      const audioBytes = await readFile(audioFixture)
      const media: MediaParseResult = {
        platform: 'douyin', input: 'https://example.com/separate', id: 'separate', title: 'separate', authorName: '', cover: '', durationSec: 1,
        streams: [
          { id: 'video', kind: 'video', combined: false, label: '720P', url: 'https://example.com/video', backupUrls: [], available: true, reason: '' },
          { id: 'audio', kind: 'audio', combined: false, label: '128K', url: 'https://example.com/audio', backupUrls: [], available: true, reason: '' },
        ],
        itemCount: 1, capabilities: { video: true, audio: true, image: false, download: true },
      }
      const taskService = new TaskService({
        repo: repo as never, platforms: {} as never, media: { parse: async () => media } as never,
        config: { get: () => ({ ffmpegPath: '', savePath: root, audioBitrateKbps: 128, downloadPoolSize: 1 }) } as never,
        dataDir: root,
        fetchImpl: (async (input) => new Response(String(input).endsWith('/video') ? videoBytes : audioBytes, { status: 200 })) as typeof fetch,
      })
      const probe = (name: string) => execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', path.join(root, name)], { encoding: 'utf8' }).trim().split('\n')

      const result = await taskService.create({ platform: 'douyin', input: media.input, mode: 'video+audio', audioContainer: 'm4a', title: media.title })
      await waitFor(() => ['success', 'fail'].includes(taskService.get(result.task.id)?.status ?? ''))
      expect(taskService.get(result.task.id)).toMatchObject({ status: 'success', files: [{ kind: 'video', fileName: 'separate-video.mp4' }, { kind: 'audio', fileName: 'separate-audio.m4a' }] })
      expect(probe('separate-video.mp4')).toEqual(['video', 'audio'])
      expect(probe('separate-audio.m4a')).toEqual(['audio'])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('marks persisted waiting tasks as retryable after a restart', () => {
    const repo = new FakeTaskRepository()
    repo.seed({
      id: 'interrupted', platform: 'bilibili', input: '', sourceId: '', bvid: 'BV1GJ411x7h7', cid: 1,
      title: 'interrupted', status: 'waiting', phase: 'pending', mode: 'video+audio', totalBytes: 0,
      downloadedBytes: 0, speedBps: 0, fileName: '', files: [], error: '', updatedAt: Date.now(),
    })
    new TaskService({
      repo: repo as never,
      platforms: {} as never,
      media: {} as never,
      config: { get: () => ({ ffmpegPath: '', savePath: './download', audioBitrateKbps: 128, downloadPoolSize: 1 }) } as never,
      dataDir: '/tmp/mediaGrab-recovery-test',
      fetchImpl: fetch,
    })

    expect(repo.get('interrupted')).toMatchObject({ status: 'fail', error: '应用上次退出时任务未完成，可点击重试' })
  })
})
