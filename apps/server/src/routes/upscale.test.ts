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
        for (const [url, method] of [['/api/upscale/tasks', 'GET'], ['/api/upscale/capability', 'GET'], ['/api/upscale/grants', 'POST'], [`/api/upscale/tasks/${randomUUID()}/thumbnail`, 'GET'], [`/api/upscale/grants/${randomUUID()}/thumbnail`, 'GET'], [`/api/upscale/grants/${randomUUID()}/repair-preview`, 'POST']] as const) {
          expect((await app.inject({ method, url })).statusCode).toBe(403)
        }
        expect((await app.inject({ method: 'DELETE', url: `/api/upscale/tasks/${randomUUID()}` })).statusCode).toBe(403)
      } finally { await app.close() }
    }
  })
  it('passes image mode through after verifying native file and directory proofs', async () => {
    const services = createServices({ config: defaultAppConfig(), dbPath: ':memory:' })
    const authorize = vi.spyOn(services.upscale, 'authorize').mockResolvedValue({
      grant: randomUUID(), kind: 'image', media: { width: 320, height: 240, fps: '1/1', frames: 1, duration: 1, audio: false },
    })
    const app = await buildApp({ config: defaultAppConfig(), services, logger: false, coreToken: token })
    const headers = { 'x-mediagrab-token': token, origin: 'tauri://localhost' }
    const input = { path: '/private/photo.jpg', proof: coreProof(token, 'upscale-input\0/private/photo.jpg') }
    const directory = { path: '/private', proof: coreProof(token, 'upscale-directory\0/private') }
    try {
      const response = await app.inject({ method: 'POST', url: '/api/upscale/grants', headers, payload: { input, directory, kind: 'image' } })
      expect(response.statusCode).toBe(200)
      expect(response.json()).toMatchObject({ kind: 'image', media: { frames: 1 } })
      expect(authorize).toHaveBeenCalledWith(input.path, directory.path, 'image')
    } finally { await app.close() }
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

it('propagates preview request disconnection to the owned abort signal', async () => {
  const token = 'c'.repeat(64), services = createServices({ config: defaultAppConfig(), dbPath: ':memory:' })
  let observed: AbortSignal | undefined
  vi.spyOn(services.upscale, 'repairPreview').mockImplementation((_id, _strokes, signal) => {
    observed = signal
    return new Promise((_resolve, reject) => signal!.addEventListener('abort', () => reject(new Error('preview request cancelled')), { once: true }))
  })
  const app = await buildApp({ config: defaultAppConfig(), services, coreToken: token, logger: false }), controller = new AbortController()
  try {
    const address = await app.listen({ host: '127.0.0.1', port: 0 })
    const response = fetch(`${address}/api/upscale/grants/${randomUUID()}/repair-preview`, { method: 'POST', headers: { 'x-mediagrab-token': token, origin: 'tauri://localhost', 'Content-Type': 'application/json' }, body: JSON.stringify({ strokes: [{ radius: .04, points: [{ x: .5, y: .5 }] }] }), signal: controller.signal }).catch(() => undefined)
    await expect.poll(() => Boolean(observed)).toBe(true)
    expect(observed!.aborted).toBe(false)
    controller.abort(); await response
    await expect.poll(() => observed!.aborted).toBe(true)
  } finally { controller.abort(); await app.close() }
})

it('preserves actionable storage error codes in the authenticated API response', async () => {
  const services = createServices({ config: defaultAppConfig(), dbPath: ':memory:' })
  const { ApiError } = await import('../lib/errors.js')
  vi.spyOn(services.upscale, 'create').mockRejectedValue(new ApiError('STORAGE_FULL', '存储空间不足，已暂停新任务', 'fatal', 503))
  const token = 'd'.repeat(64), app = await buildApp({ config: defaultAppConfig(), services, coreToken: token, logger: false })
  try {
    const response = await app.inject({ method: 'POST', url: '/api/upscale/tasks', headers: { 'x-mediagrab-token': token, origin: 'tauri://localhost' }, payload: { grant: randomUUID(), fileName: 'storage.mp4' } })
    expect(response.statusCode).toBe(503)
    expect(response.json().error).toMatchObject({ code: 'STORAGE_FULL', message: expect.stringContaining('空间不足') })
  } finally { await app.close() }
})


it('reports live storage blocking through task polling without implicitly retrying', async () => {
  const services = createServices({ config: defaultAppConfig(), dbPath: ':memory:' })
  const reason = vi.spyOn(services.upscale, 'storageReason', 'get').mockReturnValue('输出卷空间不足，已暂停队列')
  const capabilities = vi.spyOn(services.upscale, 'capabilities')
  const token = 'e'.repeat(64), app = await buildApp({ config: defaultAppConfig(), services, coreToken: token, logger: false })
  const headers = { 'x-mediagrab-token': token, origin: 'tauri://localhost' }
  try {
    expect((await app.inject({ url: '/api/upscale/tasks', headers })).json()).toEqual({ tasks: [], storageReason: '输出卷空间不足，已暂停队列' })
    expect(capabilities).not.toHaveBeenCalled()
    reason.mockReturnValue(undefined)
    expect((await app.inject({ url: '/api/upscale/tasks', headers })).json()).toEqual({ tasks: [] })
  } finally { await app.close() }
})
