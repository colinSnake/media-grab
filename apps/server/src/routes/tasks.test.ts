import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'
import { describe, expect, it } from 'vitest'
import type { TaskSnapshot } from '@mediagrab/shared'
import { httpStatusOf, toApiErrorBody } from '../lib/errors.js'
import { taskRoutes } from './tasks.js'

describe('task file downloads', () => {
  it('serves each output from the same task and keeps legacy single-file access', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'mediagrab-files-'))
    const app = Fastify()
    const task = {
      id: 'test', status: 'success', fileName: 'clip-video.mp4',
      files: [{ kind: 'video', fileName: 'clip-video.mp4' }, { kind: 'audio', fileName: 'clip-audio.m4a' }],
    } as TaskSnapshot
    try {
      app.setErrorHandler((error, _request, reply) => reply.status(httpStatusOf(error)).send(toApiErrorBody(error)))
      await writeFile(path.join(root, 'clip-video.mp4'), 'video')
      await writeFile(path.join(root, 'clip-audio.m4a'), 'audio')
      await app.register(taskRoutes, { services: {
        downloads: { get: (id: string) => id === task.id ? task : null },
        config: { get: () => ({ savePath: root }) },
      } as never })

      const video = await app.inject({ method: 'GET', url: '/api/tasks/test/file?kind=video' })
      const audio = await app.inject({ method: 'GET', url: '/api/tasks/test/file?kind=audio' })
      const legacy = await app.inject({ method: 'GET', url: '/api/tasks/test/file' })
      expect(video.body).toBe('video')
      expect(audio.body).toBe('audio')
      expect(audio.headers['content-disposition']).toContain('clip-audio.m4a')
      expect(legacy.body).toBe('video')
      expect((await app.inject({ method: 'GET', url: '/api/tasks/test/file?kind=image' })).statusCode).toBe(404)
      expect((await app.inject({ method: 'GET', url: '/api/tasks/test/file?kind=other' })).statusCode).toBe(400)
    } finally {
      await app.close()
      await rm(root, { recursive: true, force: true })
    }
  })
})
