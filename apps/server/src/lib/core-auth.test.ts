import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { coreProof, isPermittedMediaQuery, matchesCoreToken } from './core-auth.js'

const token = 'a'.repeat(64)

describe('packaged desktop core auth', () => {
  it('compares complete per-launch credentials, never prefixes', () => {
    expect(matchesCoreToken(token, token)).toBe(true)
    expect(matchesCoreToken(token, token.slice(0, -1))).toBe(false)
    expect(matchesCoreToken(token, 'b'.repeat(64))).toBe(false)
    expect(matchesCoreToken(token, undefined)).toBe(false)
  })
  it('signs each random challenge without disclosing its secret', () => {
    expect(coreProof(token, 'b'.repeat(32))).toBe(createHmac('sha256', token).update('b'.repeat(32)).digest('hex'))
    expect(coreProof(token, 'a'.repeat(32))).not.toBe(coreProof(token, 'b'.repeat(32)))
  })
  it('only permits query credentials on read-only subresources', () => {
    expect(isPermittedMediaQuery('HEAD', '/api/cover')).toBe(true)
    expect(isPermittedMediaQuery('POST', '/api/cover')).toBe(false)
    expect(isPermittedMediaQuery('GET', '/api/config')).toBe(false)
    expect(isPermittedMediaQuery('GET', '/api/tasks/123/file')).toBe(false)
  })
})
