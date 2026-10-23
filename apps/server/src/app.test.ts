import path from 'node:path'
import { tmpdir } from 'node:os'
import { defaultAppConfig } from '@mediagrab/shared'
import type { FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildApp } from './app.js'

describe('desktop API access', () => {
  let app: FastifyInstance

  beforeEach(async () => {
    app = await buildApp({
      config: defaultAppConfig(),
      dbPath: ':memory:',
      logger: false,
      webDist: path.join(tmpdir(), 'mediagrab-cors-test-no-web'),
    })
  })

  afterEach(async () => {
    await app.close()
  })

  it.each([
    'tauri://localhost',
    'http://tauri.localhost',
    'https://tauri.localhost',
    'http://localhost:9067',
    'http://127.0.0.1:9067',
  ])('allows the desktop origin %s', async (origin) => {
    const response = await app.inject({ method: 'GET', url: '/api/health', headers: { origin } })
    expect(response.statusCode).toBe(200)
    expect(response.headers['access-control-allow-origin']).toBe(origin)
    expect(response.json().ok).toBe(true)
  })

  it('allows desktop JSON requests to update settings', async () => {
    const response = await app.inject({
      method: 'OPTIONS',
      url: '/api/config',
      headers: {
        origin: 'tauri://localhost',
        'access-control-request-method': 'PATCH',
        'access-control-request-headers': 'content-type',
      },
    })
    expect(response.statusCode).toBe(204)
    expect(response.headers['access-control-allow-origin']).toBe('tauri://localhost')
    expect(response.headers['access-control-allow-methods']).toContain('PATCH')
    expect(response.headers['access-control-allow-headers']).toContain('Content-Type')
    expect(response.headers['access-control-allow-headers']).toContain('X-Mediagrab-Token')
  })

  it('does not allow arbitrary websites to read local data', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/health', headers: { origin: 'https://example.com' } })
    expect(response.headers['access-control-allow-origin']).toBeUndefined()
  })

  it.each([
    { host: 'evil.example:9070', origin: undefined },
    { host: 'evil.example:9070', origin: 'tauri://localhost' },
    { host: '127.0.0.1:9070', origin: 'https://evil.example' },
    { host: '127.0.0.1:9070', origin: 'null' },
    { host: '127.0.0.1:9070', origin: 'http://127.0.0.1:9999' },
  ])('rejects foreign Host/Origin for API requests (%j)', async ({ host, origin }) => {
    const response = await app.inject({ method: 'GET', url: '/api/config', headers: { host, ...(origin && { origin }) } })
    expect(response.statusCode).toBe(403)
    expect(response.json()).toMatchObject({ error: { code: 'LOCAL_ACCESS_DENIED' } })
  })

  it('rejects an external website attempting a simple form POST', async () => {
    const response = await app.inject({
      method: 'POST', url: '/api/tasks',
      headers: { host: '127.0.0.1:9070', origin: 'https://evil.example', 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'input=https://example.com',
    })
    expect(response.statusCode).toBe(403)
  })

  it('allows the core web UI to write from the same origin but not another loopback port', async () => {
    const allowed = await app.inject({ method: 'GET', url: '/api/config', headers: {
      host: '127.0.0.1:9070', origin: 'http://127.0.0.1:9070',
    } })
    expect(allowed.statusCode).toBe(200)
    expect(allowed.headers['access-control-allow-origin']).toBe('http://127.0.0.1:9070')
  })

  it('rejects changing the listening interface away from loopback', async () => {
    const response = await app.inject({ method: 'PATCH', url: '/api/config',
      payload: { bindHost: '0.0.0.0' },
    })
    expect(response.statusCode).toBe(400)
    expect(response.json()).toMatchObject({ error: { code: 'INVALID_CONFIG' } })
  })

  it('serves only loopback HTTP and rejects cross-site requests on a live socket', async () => {
    const address = await app.listen({ host: '127.0.0.1', port: 0 })
    const health = await fetch(`${address}/api/health`)
    expect(health.status).toBe(200)
    const foreign = await fetch(`${address}/api/config`, { headers: { origin: 'https://evil.example' } })
    expect(foreign.status).toBe(403)
    expect((await foreign.json()) as object).toMatchObject({ error: { code: 'LOCAL_ACCESS_DENIED' } })
  })

  it('locks the packaged desktop endpoint even when settings are patched', async () => {
    const desktop = await buildApp({
      config: defaultAppConfig(), dbPath: ':memory:', logger: false, desktopCore: true,
      webDist: path.join(tmpdir(), 'mediagrab-no-web'),
    })
    try {
      for (const payload of [{ serverPort: 9071 }, { bindHost: 'localhost' }]) {
        const response = await desktop.inject({ method: 'PATCH', url: '/api/config', payload })
        expect(response.statusCode).toBe(400)
        expect(response.json()).toMatchObject({ error: { code: 'DESKTOP_LISTEN_LOCKED' } })
      }
      const allowed = await desktop.inject({ method: 'PATCH', url: '/api/config', payload: { downloadPoolSize: 2 } })
      expect(allowed.statusCode).toBe(200)
    } finally {
      await desktop.close()
    }
  })

  it('requires a per-launch token on desktop APIs and signs a health challenge', async () => {
    const token = 'a'.repeat(64)
    const desktop = await buildApp({ config: defaultAppConfig(), dbPath: ':memory:', logger: false, coreToken: token })
    try {
      const denied = await desktop.inject({ method: 'GET', url: '/api/config' })
      expect(denied.statusCode).toBe(403)
      expect(denied.json()).toMatchObject({ error: { code: 'CORE_AUTH_REQUIRED' } })
      const configured = await desktop.inject({ method: 'GET', url: '/api/config', headers: { 'x-mediagrab-token': token } })
      expect(configured.statusCode).toBe(200)
      const fakeQuery = await desktop.inject({ method: 'GET', url: `/api/config?media_token=${token}` })
      expect(fakeQuery.statusCode).toBe(403)
      const webSocketDenied = await desktop.inject({ method: 'GET', url: '/api/ws', headers: { upgrade: 'websocket' } })
      expect(webSocketDenied.statusCode).toBe(403)
      const challenge = await desktop.inject({ method: 'GET', url: '/api/health', headers: { 'x-mediagrab-nonce': 'b'.repeat(32) } })
      expect(challenge.statusCode).toBe(200)
      expect(challenge.headers['x-mediagrab-proof']).toMatch(/^[a-f0-9]{64}$/)
      const noChallenge = await desktop.inject({ method: 'GET', url: '/api/health' })
      expect(noChallenge.headers['x-mediagrab-proof']).toBeUndefined()
    } finally {
      await desktop.close()
    }
  })

  it('authorizes a real WebSocket using only its per-launch subprotocol', async () => {
    const token = 'a'.repeat(64)
    const desktop = await buildApp({ config: defaultAppConfig(), dbPath: ':memory:', logger: false, coreToken: token })
    let socket: WebSocket | undefined
    try {
      const address = await desktop.listen({ host: '127.0.0.1', port: 0 })
      socket = new WebSocket(address.replace(/^http/, 'ws') + '/api/ws', [`mg-${token}`])
      const hello = await new Promise<unknown>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('WebSocket authentication timed out')), 4000)
        socket!.addEventListener('message', (event) => { clearTimeout(timeout); resolve(JSON.parse(String(event.data))) }, { once: true })
        socket!.addEventListener('error', () => { clearTimeout(timeout); reject(new Error('WebSocket authentication rejected')) }, { once: true })
      })
      expect(hello).toMatchObject({ type: 'hello' })
    } finally {
      socket?.close()
      await desktop.close()
    }
  })

})
