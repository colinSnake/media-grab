import { createHmac, timingSafeEqual } from 'node:crypto'

export const CORE_TOKEN_HEADER = 'x-mediagrab-token'
export const CORE_NONCE_HEADER = 'x-mediagrab-nonce'
export const CORE_PROOF_HEADER = 'x-mediagrab-proof'

export function coreProof(token: string, nonce: string): string {
  return createHmac('sha256', token).update(nonce).digest('hex')
}

export function matchesCoreToken(expected: string, provided: unknown): boolean {
  if (typeof provided !== 'string' || !/^[a-f0-9]{64}$/.test(provided)) return false
  const left = Buffer.from(expected, 'utf8')
  const right = Buffer.from(provided, 'utf8')
  return left.length === right.length && timingSafeEqual(left, right)
}

export function isPermittedMediaQuery(method: string, pathname: string): boolean {
  return (method === 'GET' || method === 'HEAD') && (
    pathname === '/api/cover'
  )
}
