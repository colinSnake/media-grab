import { describe, expect, it, vi } from 'vitest'
import { defaultAppConfig } from '@mediagrab/shared'
import { buildApp } from '../app.js'
import { coreProof } from '../lib/core-auth.js'
import { createServices } from '../services.js'
import { UpscaleService } from '../upscale/service.js'
import { randomUUID } from 'node:crypto'

describe('upscale file access is desktop-authenticated', () => {
  const token = 'a'.repeat(64)
  it('rejects browser-only deployment and unauthenticated desktop requests', async () => {
    for (const coreToken of [undefined, token]) {
      const app = await buildApp({ config: defaultAppConfig(), dbPath: ':memory:', logger: false, coreToken })
      try {
        for (const url of ['/api/upscale/tasks', '/api/upscale/capability', '/api/upscale/grants', `/api/upscale/tasks/${randomUUID()}/thumbnail`]) {
          expect((await app.inject({ method: url.endsWith('grants') ? 'POST' : 'GET', url })).statusCode).toBe(403)
        }
        expect((await app.inject({ method: 'DELETE', url: `/api/upscale/tasks/${randomUUID()}` })).statusCode).toBe(403)
      } finally { await app.close() }
    }
  })
  it('requires native selection signatures, rejects path-only payloads, and keeps download APIs working', async () => {
    const app = await buildApp({ config: defaultAppConfig(), dbPath: ':memory:', logger: false, coreToken: token })
    const headers = { 'x-mediagrab-token': token, origin: 'tauri://localhost' }
    try {
      expect((await app.inject({ url: '/api/tasks', headers })).statusCode).toBe(200)
      expect((await app.inject({ url: '/api/upscale/tasks', headers })).json()).toEqual({ tasks: [] })
      const input = { path: '/private/video.mp4', proof: '0'.repeat(64) }, directory = { path: '/private', proof: coreProof(token, 'upscale-directory\0/private') }
      expect((await app.inject({ method: 'POST', url: '/api/upscale/grants', headers, payload: { input, directory } })).statusCode).toBe(403)
      expect((await app.inject({ method: 'POST', url: '/api/upscale/tasks', headers, payload: { input: input.path, output: '/private/out.mp4' } })).statusCode).toBe(400)
      expect((await app.inject({ url: '/api/upscale/tasks', headers: { ...headers, origin: 'https://evil.test' } })).statusCode).toBe(403)
    } finally { await app.close() }
  })
})


it('deletes upscale history through the authenticated API and keeps records deleted after refresh', async () => {
  const token = 'a'.repeat(64), id = randomUUID()
  const services = createServices({ config: defaultAppConfig(), dbPath: ':memory:' })
  await services.upscale.close()
  const task = { id, input: '/fixture/input.mp4', output: '/fixture/output.mp4', model: 'realesr-animevideov3-x2', status: 'failed', stage: 'encoding', completedFrames: 12, createdAt: 1, updatedAt: 1 }
  services.db.prepare('INSERT INTO upscale_tasks VALUES(?,?,?)').run(id, JSON.stringify({ task, identity: 'fixture' }), 1)
  services.upscale = new UpscaleService(services.db)
  const app = await buildApp({ config: defaultAppConfig(), services, coreToken: token, logger: false })
  const headers = { 'x-mediagrab-token': token, origin: 'tauri://localhost' }
  try {
    expect((await app.inject({ url: '/api/upscale/tasks', headers })).json().tasks).toHaveLength(1)
    expect((await app.inject({ method: 'DELETE', url: `/api/upscale/tasks/${id}` })).statusCode).toBe(403)
    expect((await app.inject({ method: 'DELETE', url: `/api/upscale/tasks/${id}`, headers: { ...headers, origin: 'https://evil.test' } })).statusCode).toBe(403)
    expect((await app.inject({ method: 'DELETE', url: `/api/upscale/tasks/${id}`, headers })).statusCode).toBe(204)
    expect((await app.inject({ url: '/api/upscale/tasks', headers })).json()).toEqual({ tasks: [] })
    expect((await app.inject({ method: 'DELETE', url: `/api/upscale/tasks/${id}`, headers })).statusCode).toBe(404)
  } finally { await app.close() }
})


it('protects first-frame previews with desktop headers and returns only bounded task-owned images', async () => {
  const token = 'b'.repeat(64), id = randomUUID()
  const services = createServices({ config: defaultAppConfig(), dbPath: ':memory:' })
  const image = Buffer.from('89504e470d0a1a0a', 'hex')
  const thumbnail = vi.spyOn(services.upscale, 'thumbnail').mockResolvedValue(image)
  const app = await buildApp({ config: defaultAppConfig(), services, coreToken: token, logger: false })
  const url = `/api/upscale/tasks/${id}/thumbnail`, headers = { 'x-mediagrab-token': token, origin: 'tauri://localhost' }
  try {
    expect((await app.inject({ url })).statusCode).toBe(403)
    expect((await app.inject({ url, headers: { ...headers, origin: 'https://evil.test' } })).statusCode).toBe(403)
    expect(thumbnail).not.toHaveBeenCalled()
    const response = await app.inject({ url, headers })
    expect(response.statusCode).toBe(200)
    expect(response.headers['content-type']).toBe('image/png')
    expect(response.headers['cache-control']).toBe('no-store')
    expect(response.rawPayload).toEqual(image)
    expect(thumbnail).toHaveBeenCalledWith(id)
  } finally { await app.close() }
})
