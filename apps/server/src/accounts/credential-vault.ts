import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { resolveDataDir } from '../paths.js'

interface VaultEntry {
  iv: string
  tag: string
  value: string
}

type VaultData = Record<string, VaultEntry>

/**
 * 本机凭据保险箱。
 *
 * 当前过渡核心使用 AES-256-GCM + 0600 权限文件保存 Cookie，数据库只存账号元数据。
 * Tauri 原生壳接管后可把同一接口替换为 macOS Keychain / Windows Credential Manager。
 */
export class CredentialVault {
  readonly #dir: string
  readonly #keyPath: string
  readonly #dataPath: string
  #key: Buffer
  #memory: VaultData | undefined

  static inMemory(): CredentialVault {
    return new CredentialVault(null)
  }

  constructor(dir: string | null = resolveDataDir()) {
    if (dir === null) {
      this.#dir = ''
      this.#keyPath = ''
      this.#dataPath = ''
      this.#key = randomBytes(32)
      this.#memory = {}
      return
    }
    this.#dir = dir
    this.#keyPath = path.join(dir, '.credentials.key')
    this.#dataPath = path.join(dir, 'credentials.vault')
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    chmodSync(dir, 0o700)
    this.#key = this.#loadKey()
  }

  get(id: string): string | null {
    const entry = this.#load()[id]
    if (!entry) return null
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.#key, Buffer.from(entry.iv, 'base64'))
      decipher.setAuthTag(Buffer.from(entry.tag, 'base64'))
      return Buffer.concat([decipher.update(Buffer.from(entry.value, 'base64')), decipher.final()]).toString('utf8')
    } catch {
      throw new Error('账号凭据无法解密，可能已损坏或当前用户无权访问')
    }
  }

  set(id: string, value: string): void {
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', this.#key, iv)
    const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
    const data = this.#load()
    data[id] = { iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), value: encrypted.toString('base64') }
    this.#save(data)
  }

  delete(id: string): void {
    const data = this.#load()
    delete data[id]
    this.#save(data)
  }

  #loadKey(): Buffer {
    if (!existsSync(this.#keyPath)) {
      const key = randomBytes(32)
      writeFileSync(this.#keyPath, key, { mode: 0o600 })
      chmodSync(this.#keyPath, 0o600)
      return key
    }
    const key = readFileSync(this.#keyPath)
    if (key.length !== 32) throw new Error('账号凭据密钥长度不正确')
    return key
  }

  #load(): VaultData {
    if (this.#memory !== undefined) return { ...this.#memory }
    if (!existsSync(this.#dataPath)) return {}
    try {
      return JSON.parse(readFileSync(this.#dataPath, 'utf8')) as VaultData
    } catch {
      throw new Error('账号凭据保险箱无法读取')
    }
  }

  #save(data: VaultData): void {
    if (this.#memory !== undefined) {
      this.#memory = data
      return
    }
    const tempPath = `${this.#dataPath}.${process.pid}.tmp`
    writeFileSync(tempPath, JSON.stringify(data), { mode: 0o600 })
    chmodSync(tempPath, 0o600)
    renameSync(tempPath, this.#dataPath)
    chmodSync(this.#dataPath, 0o600)
  }
}
