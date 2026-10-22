import { access, mkdtemp, readdir, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { MediaParseResult, TaskSnapshot } from '@mediagrab/shared'
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
      streams: [{ id: 'combined-video', kind: 'video', combined: true, label: '720P', url: 'https://example.com/video', backupUrls: [], available: true, reason: '' }],
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
      const first = await taskService.create({ platform: 'douyin', input: 'https://example.com/video/1', mode: 'video+audio', audioContainer: 'm4a', title: '' })
      const second = await taskService.create({ platform: 'douyin', input: 'https://example.com/video/2', mode: 'video+audio', audioContainer: 'm4a', title: '' })

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

  it('falls back to an alternate stream URL when the primary URL fails', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'mediaGrab-fallback-'))
    const repo = new FakeTaskRepository()
    const media: MediaParseResult = {
      platform: 'douyin', input: 'https://example.com/video/fallback', id: 'fallback', title: 'fallback-test', authorName: '', cover: '', durationSec: 1,
      streams: [{ id: 'combined', kind: 'video', combined: true, label: '720P', url: 'https://example.com/primary', backupUrls: ['https://example.com/backup'], available: true, reason: '' }],
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

  it('marks persisted waiting tasks as retryable after a restart', () => {
    const repo = new FakeTaskRepository()
    repo.seed({
      id: 'interrupted', platform: 'bilibili', input: '', sourceId: '', bvid: 'BV1GJ411x7h7', cid: 1,
      title: 'interrupted', status: 'waiting', phase: 'pending', mode: 'video+audio', totalBytes: 0,
      downloadedBytes: 0, speedBps: 0, fileName: '', error: '', updatedAt: Date.now(),
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
