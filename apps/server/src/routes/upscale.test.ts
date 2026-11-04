import { describe, expect, it } from 'vitest'
import { defaultAppConfig } from '@mediagrab/shared'
import { buildApp } from '../app.js'
import { coreProof } from '../lib/core-auth.js'

describe('upscale file access is desktop-authenticated', () => {
  const token = 'a'.repeat(64)
  it('rejects browser-only deployment and unauthenticated desktop requests', async () => {
    for (const coreToken of [undefined, token]) {
      const app = await buildApp({ config: defaultAppConfig(), dbPath: ':memory:', logger: false, coreToken })
      try {
        for (const url of ['/api/upscale/tasks', '/api/upscale/capability', '/api/upscale/grants']) {
          expect((await app.inject({ method: url.endsWith('grants') ? 'POST' : 'GET', url })).statusCode).toBe(403)
        }
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
