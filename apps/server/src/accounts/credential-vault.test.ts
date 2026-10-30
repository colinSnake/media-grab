import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { credentialEncryptionHeader, credentialPreviewSchema } from '@mediagrab/shared'
import { CredentialVault } from './credential-vault.js'

describe('CredentialVault', () => {
  it('returns complete, independently decryptable JWE ciphertext and retains it after restart', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'mediagrab-vault-test-'))
    try {
      const cookie = `SESSDATA=unique-secret; token=${'long-cookie-value'.repeat(1000)}`
      const vault = new CredentialVault(dir)
      vault.set('account', cookie)
      const preview = vault.preview('account')
      expect(credentialPreviewSchema.parse(preview)).toBe(preview)
      expect(preview!.length).toBeGreaterThan(cookie.length)
      const [header, encryptedKey, iv, ciphertext, tag] = preview!.split('.')
      expect(JSON.parse(Buffer.from(header!, 'base64url').toString())).toEqual({ alg: 'dir', enc: 'A256GCM' })
      expect(encryptedKey).toBe('')
      const key = readFileSync(path.join(dir, '.credentials.key'))
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv!, 'base64url'))
      decipher.setAAD(Buffer.from(header!, 'ascii'))
      decipher.setAuthTag(Buffer.from(tag!, 'base64url'))
      expect(Buffer.concat([decipher.update(Buffer.from(ciphertext!, 'base64url')), decipher.final()]).toString()).toBe(cookie)
      const stored = readFileSync(path.join(dir, 'credentials.vault'), 'utf8')
      expect(stored).not.toContain('unique-secret')
      expect(stored).not.toContain(Buffer.from(cookie).toString('base64'))
      const restored = new CredentialVault(dir)
      expect(restored.get('account')).toBe(cookie)
      expect(restored.preview('account')).toBe(preview)
      restored.delete('account')
      expect(restored.preview('account')).toBeNull()
      expect(restored.get('account')).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('uses independent randomized ciphertext for equal plaintext', () => {
    const vault = CredentialVault.inMemory()
    vault.set('first', 'SESSDATA=same-secret')
    vault.set('second', 'SESSDATA=same-secret')
    expect(vault.preview('first')).not.toBe(vault.preview('second'))
    expect(vault.get('first')).toBe(vault.get('second'))
  })

  it('migrates legacy encrypted entries with a fresh IV and preserves credentials on restart', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'mediagrab-vault-test-'))
    try {
      new CredentialVault(dir)
      const key = readFileSync(path.join(dir, '.credentials.key'))
      const iv = randomBytes(12)
      const cookie = 'SESSDATA=legacy-secret'
      const cipher = createCipheriv('aes-256-gcm', key, iv)
      const value = Buffer.concat([cipher.update(cookie, 'utf8'), cipher.final()])
      writeFileSync(path.join(dir, 'credentials.vault'), JSON.stringify({
        legacy: { iv: iv.toString('base64'), value: value.toString('base64'), tag: cipher.getAuthTag().toString('base64') },
      }))
      const vault = new CredentialVault(dir)
      expect(vault.get('legacy')).toBe(cookie)
      vault.set('other', 'SID=untouched')
      const preview = vault.preview('legacy')!
      expect(credentialPreviewSchema.parse(preview)).toBe(preview)
      expect(preview.split('.')[2]).not.toBe(iv.toString('base64url'))
      const restored = new CredentialVault(dir)
      expect(restored.get('legacy')).toBe(cookie)
      expect(restored.get('other')).toBe('SID=untouched')
      expect(restored.preview('legacy')).toBe(preview)
      expect(readFileSync(path.join(dir, '.credentials.key'))).toEqual(key)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('authenticates the encryption header and rejects the previous short identifier format', () => {
    expect(credentialPreviewSchema.safeParse('AbCdEfGhIjKlMnOp').success).toBe(false)
    expect(JSON.parse(Buffer.from(credentialEncryptionHeader, 'base64url').toString())).toEqual({ alg: 'dir', enc: 'A256GCM' })
    const dir = mkdtempSync(path.join(tmpdir(), 'mediagrab-vault-test-'))
    try {
      new CredentialVault(dir).set('account', 'SESSDATA=secret')
      const vaultPath = path.join(dir, 'credentials.vault')
      const stored = JSON.parse(readFileSync(vaultPath, 'utf8'))
      stored.account.protected = Buffer.from('{"alg":"dir","enc":"A128GCM"}').toString('base64url')
      writeFileSync(vaultPath, JSON.stringify(stored))
      expect(() => new CredentialVault(dir).get('account')).toThrow('账号凭据无法解密')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('rejects tampered encrypted credentials', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'mediagrab-vault-test-'))
    try {
      new CredentialVault(dir).set('account', 'SESSDATA=secret')
      const vaultPath = path.join(dir, 'credentials.vault')
      const stored = JSON.parse(readFileSync(vaultPath, 'utf8'))
      const bytes = Buffer.from(stored.account.value, 'base64')
      bytes[0] = (bytes[0] ?? 0) ^ 1
      stored.account.value = bytes.toString('base64')
      writeFileSync(vaultPath, JSON.stringify(stored))
      expect(() => new CredentialVault(dir).get('account')).toThrow('账号凭据无法解密')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
