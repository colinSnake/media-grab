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

  it.each(['tauri://localhost', 'http://tauri.localhost', 'https://tauri.localhost'])('allows the desktop origin %s', async (origin) => {
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
    expect(response.headers['access-control-allow-headers']).toBe('Content-Type')
  })

  it('does not allow arbitrary websites to read local data', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/health', headers: { origin: 'https://example.com' } })
    expect(response.headers['access-control-allow-origin']).toBeUndefined()
  })
})
