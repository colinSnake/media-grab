import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'
import { describe, expect, it, vi } from 'vitest'
import { taskSnapshotSchema, type TaskSnapshot } from '@mediagrab/shared'
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

  it('serves files from their original directory after the configured directory changes', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'mediagrab-original-'))
    const original = path.join(root, 'original')
    const current = path.join(root, 'current')
    const app = Fastify()
    const task = taskSnapshotSchema.parse({ id: 'previous', bvid: '', cid: 0, status: 'success', phase: 'done', fileName: 'clip.mp4', outputDir: original, updatedAt: Date.now() })
    try {
      app.setErrorHandler((error, _request, reply) => reply.status(httpStatusOf(error)).send(toApiErrorBody(error)))
      await mkdir(original)
      await mkdir(current)
      await writeFile(path.join(original, 'clip.mp4'), 'original')
      await writeFile(path.join(current, 'clip.mp4'), 'wrong-file')
      await app.register(taskRoutes, { services: {
        downloads: { get: () => task }, config: { get: () => ({ savePath: current }) },
      } as never })

      expect((await app.inject({ method: 'GET', url: '/api/tasks/previous/file' })).body).toBe('original')
      await rm(path.join(original, 'clip.mp4'))
      const missing = await app.inject({ method: 'GET', url: '/api/tasks/previous/file' })
      expect(missing.statusCode).toBe(404)
      expect(missing.json().error.code).toBe('FILE_NOT_FOUND')
      // Legacy snapshots without outputDir still use the current configured directory.
      task.outputDir = undefined
      expect((await app.inject({ method: 'GET', url: '/api/tasks/previous/file' })).body).toBe('wrong-file')
    } finally {
      await app.close()
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('task deletion', () => {
  it('waits for an active queue task to finish cancellation before replying', async () => {
    const app = Fastify()
    let finishRemoval!: (removed: boolean) => void
    const removal = new Promise<boolean>((resolve) => { finishRemoval = resolve })
    const remove = vi.fn(() => removal)
    try {
      await app.register(taskRoutes, { services: { downloads: { remove } } as never })
      let responded = false
      const response = app.inject({ method: 'DELETE', url: '/api/tasks/queued' }).then((reply) => {
        responded = true
        return reply
      })
      await vi.waitFor(() => expect(remove).toHaveBeenCalledWith('queued'))
      expect(responded).toBe(false)
      finishRemoval(true)
      expect((await response).statusCode).toBe(204)
    } finally {
      await app.close()
    }
  })
})

describe('queued task start', () => {
  it('starts only when the start endpoint is called and reports missing tasks', async () => {
    const app = Fastify()
    const task = { id: 'queued', status: 'waiting' } as TaskSnapshot
    const start = vi.fn((id: string) => id === task.id ? task : null)
    try {
      app.setErrorHandler((error, _request, reply) => reply.status(httpStatusOf(error)).send(toApiErrorBody(error)))
      await app.register(taskRoutes, { services: { downloads: { start } } as never })
      expect((await app.inject({ method: 'POST', url: '/api/tasks/queued/start' })).json()).toMatchObject({ id: 'queued', status: 'waiting' })
      expect(start).toHaveBeenCalledWith('queued')
      expect((await app.inject({ method: 'POST', url: '/api/tasks/missing/start' })).statusCode).toBe(404)
    } finally {
      await app.close()
    }
  })
})
