import Fastify from 'fastify'
import { describe, expect, it, vi } from 'vitest'
import { publicMediaParseResultSchema, type MediaParseResult } from '@mediagrab/shared'
import { httpStatusOf, toApiErrorBody } from '../lib/errors.js'
import { mediaRoutes } from './media.js'

describe('public media parse response', () => {
  it('omits signed upstream URLs and headers but preserves an opaque image preview', async () => {
    const source: MediaParseResult = {
      platform: 'xiaohongshu', input: 'https://www.xiaohongshu.com/explore/example', id: 'example',
      title: 'photos', authorName: '', durationSec: 0,
      cover: 'https://sns-webpic-qc.xhscdn.com/cover.jpg?sign=cover-secret',
      streams: [{ id: 'image:1', kind: 'image', combined: false, label: '图片 1',
        url: 'https://sns-webpic-qc.xhscdn.com/one.jpg?sign=image-secret',
        backupUrls: ['https://sns-webpic-qc.xhscdn.com/backup.jpg?sign=backup-secret'],
        httpHeaders: { Referer: 'https://www.xiaohongshu.com/', Authorization: 'private' },
        available: true, reason: '' }, {
        id: 'video:1', kind: 'video', combined: true, label: '720P',
        url: 'https://v3-qingtao.douyinvod.com/video.mp4?sign=video-secret',
        backupUrls: [], httpHeaders: { Referer: 'https://www.xiaohongshu.com/' },
        available: true, reason: '',
      }],
      itemCount: 1, capabilities: { video: true, audio: true, image: true, download: true },
    }
    const app = Fastify()
    const fetchMock = vi.fn(async () => new Response(new Uint8Array([0xff, 0xd8, 0xff]), { headers: { 'content-type': 'image/jpeg' } }))
    vi.stubGlobal('fetch', fetchMock)
    try {
      app.setErrorHandler((error, _req, reply) => reply.status(httpStatusOf(error)).send(toApiErrorBody(error)))
      await app.register(mediaRoutes, { services: { media: { parse: async () => source } } as never })
      const response = await app.inject({ method: 'POST', url: '/api/media/parse', payload: { input: source.input } })
      expect(response.statusCode).toBe(200)
      const data: unknown = response.json()
      const result = publicMediaParseResultSchema.parse(data)
      expect(response.body).not.toMatch(/xhscdn|douyinvod|sign=|Authorization|image-secret|cover-secret|backup-secret|video-secret/)
      expect(result.streams[0]).not.toHaveProperty('url')
      expect(result.streams[0]).not.toHaveProperty('backupUrls')
      expect(result.streams[0]).not.toHaveProperty('httpHeaders')
      expect(result.cover).toMatch(/^\/api\/cover\?ref=[a-f0-9]{32}$/)
      expect(result.streams[0]?.preview).toMatch(/^\/api\/cover\?ref=[a-f0-9]{32}$/)
      expect(result.streams[1]?.preview).toBeUndefined()
      expect((await app.inject({ method: 'GET', url: result.cover })).statusCode).toBe(200)
      expect((await app.inject({ method: 'GET', url: result.streams[0]!.preview! })).statusCode).toBe(200)
      expect(fetchMock).toHaveBeenCalledTimes(2)
      const unknown = await app.inject({ method: 'GET', url: `/api/cover?ref=${'0'.repeat(32)}` })
      expect(unknown.statusCode).toBe(404)
    } finally {
      vi.unstubAllGlobals()
      await app.close()
    }
  })
})
