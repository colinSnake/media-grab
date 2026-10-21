import { randomUUID } from 'node:crypto'
import { navSchema, type AccountSession, type AccountSummary } from '@mediagrab/shared'
import { ApiError } from '../lib/errors.js'
import type { Logger } from '../lib/logger.js'
import { silentLogger } from '../lib/logger.js'
import type { BiliHttp } from '../bili/http.js'
import { AccountRepository, type AccountRecord } from '../store/repositories.js'
import { CredentialVault } from './credential-vault.js'
import { normalizeDouyinCookie, normalizeXiaohongshuCookie } from './douyin-cookie.js'

const BILI_NAV_URL = 'https://api.bilibili.com/x/web-interface/nav'
const COOKIE_NAMES = ['SESSDATA', 'bili_jct', 'DedeUserID', 'DedeUserID__ckMd5', 'sid'] as const
const DOUYIN_COOKIE_ID = 'platform:douyin'
const XIAOHONGSHU_COOKIE_ID = 'platform:xiaohongshu'

function parseBiliCookie(raw: string): string {
  const values = new Map<string, string>()
  for (const part of raw.split(';')) {
    const separator = part.indexOf('=')
    if (separator <= 0) continue
    const name = part.slice(0, separator).trim()
    const value = part.slice(separator + 1).trim()
    if (COOKIE_NAMES.includes(name as (typeof COOKIE_NAMES)[number]) && value !== '') values.set(name, value)
  }
  if (!values.has('SESSDATA')) throw new ApiError('INVALID_ACCOUNT_COOKIE', 'B站 Cookie 缺少 SESSDATA', 'invalid', 400)
  return COOKIE_NAMES.filter((name) => values.has(name)).map((name) => `${name}=${values.get(name)}`).join('; ')
}

function summary(account: AccountRecord): AccountSummary {
  return {
    id: account.id,
    platform: account.platform,
    label: account.label,
    displayName: account.displayName,
    loggedIn: account.loggedIn,
    vip: account.vip,
    status: account.status,
    active: account.active,
    lastVerifiedAt: account.lastVerifiedAt,
  }
}

export class AccountService {
  readonly #repo: AccountRepository
  readonly #vault: CredentialVault
  readonly #http: BiliHttp
  readonly #deviceCookieProvider: () => string | undefined
  readonly #logger: Logger

  constructor(options: { repo: AccountRepository; vault?: CredentialVault | null; http: BiliHttp; deviceCookieProvider?: () => string | undefined; logger?: Logger }) {
    this.#repo = options.repo
    this.#vault = options.vault ?? new CredentialVault()
    this.#http = options.http
    this.#deviceCookieProvider = options.deviceCookieProvider ?? (() => undefined)
    this.#logger = options.logger ?? silentLogger
  }

  list(): AccountSummary[] {
    return this.#repo.list().map(summary)
  }

  activeBili(): AccountRecord | null {
    return this.#repo.list('bilibili').find((item) => item.active) ?? null
  }

  cookieHeader(): string | undefined {
    const active = this.activeBili()
    if (!active || active.status !== 'active') return undefined
    try {
      return this.#vault.get(active.id) ?? undefined
    } catch (error) {
      this.#logger.warn({ accountId: active.id, error: error instanceof Error ? error.message : String(error) }, '账号凭据读取失败')
      this.#repo.save({ ...active, status: 'invalid', loggedIn: false, vip: false, updatedAt: Date.now() })
      return undefined
    }
  }

  session(): AccountSession {
    const active = this.activeBili()
    return active && active.status === 'active'
      ? { loggedIn: active.loggedIn, vip: active.vip }
      : { loggedIn: false, vip: false }
  }

  douyinCookieConfigured(): boolean {
    return this.#vault.get(DOUYIN_COOKIE_ID) !== null
  }

  saveDouyinCookie(rawCookie: string): void {
    this.#vault.set(DOUYIN_COOKIE_ID, normalizeDouyinCookie(rawCookie))
  }

  clearDouyinCookie(): void {
    this.#vault.delete(DOUYIN_COOKIE_ID)
  }

  douyinCookie(): string | undefined {
    return this.#vault.get(DOUYIN_COOKIE_ID) ?? undefined
  }

  xiaohongshuCookieConfigured(): boolean {
    return this.#vault.get(XIAOHONGSHU_COOKIE_ID) !== null
  }

  saveXiaohongshuCookie(rawCookie: string): void {
    this.#vault.set(XIAOHONGSHU_COOKIE_ID, normalizeXiaohongshuCookie(rawCookie))
  }

  clearXiaohongshuCookie(): void {
    this.#vault.delete(XIAOHONGSHU_COOKIE_ID)
  }

  xiaohongshuCookie(): string | undefined {
    return this.#vault.get(XIAOHONGSHU_COOKIE_ID) ?? undefined
  }

  async importBili(label: string, rawCookie: string): Promise<AccountSummary> {
    const cookie = parseBiliCookie(rawCookie)
    const id = randomUUID()
    this.#vault.set(id, cookie)
    const now = Date.now()
    this.#repo.save({
      id, platform: 'bilibili', label, displayName: '', status: 'needs-login',
      loggedIn: false, vip: false, active: false, lastVerifiedAt: null, updatedAt: now,
    })
    try {
      const verified = await this.verify(id)
      this.#repo.setActive('bilibili', id)
      return { ...verified, active: true }
    } catch (error) {
      this.#logger.warn({ accountId: id, error: error instanceof Error ? error.message : String(error) }, 'B站账号验证失败')
      if (error instanceof ApiError && (error.kind === 'auth' || error.kind === 'invalid')) {
        this.#vault.delete(id)
        this.#repo.delete(id)
      }
      throw error
    }
  }

  async activate(id: string): Promise<AccountSummary> {
    const account = this.#repo.get(id)
    if (!account || account.platform !== 'bilibili') throw new ApiError('ACCOUNT_NOT_FOUND', '账号不存在', 'notFound', 404)
    const verified = await this.verify(id)
    this.#repo.setActive('bilibili', id)
    return { ...verified, active: true }
  }

  async verify(id: string): Promise<AccountSummary> {
    const account = this.#repo.get(id)
    if (!account) throw new ApiError('ACCOUNT_NOT_FOUND', '账号不存在', 'notFound', 404)
    const cookie = this.#vault.get(id)
    if (!cookie) throw new ApiError('ACCOUNT_CREDENTIAL_MISSING', '账号凭据不存在，请重新导入', 'auth', 403)
    const response = await this.#http.json(navSchema, BILI_NAV_URL, {
      class: 'api',
      referer: 'https://www.bilibili.com/',
      acceptCodes: [0, -101],
      headers: { Cookie: [this.#deviceCookieProvider(), cookie].filter(Boolean).join('; ') },
      label: 'account:bili:verify',
    })
    const data = response.envelope.data
    const loggedIn = data.isLogin
    const vip = loggedIn && (data.vipStatus ?? 0) > 0
    const next: AccountRecord = {
      ...account,
      displayName: data.uname ?? '',
      status: loggedIn ? 'active' : 'needs-login',
      loggedIn,
      vip,
      active: account.active,
      lastVerifiedAt: Date.now(),
      updatedAt: Date.now(),
    }
    this.#repo.save(next)
    if (!loggedIn) throw new ApiError('ACCOUNT_NOT_LOGGED_IN', 'B站 Cookie 已失效或未登录', 'auth', 403)
    return summary(next)
  }

  remove(id: string): void {
    const account = this.#repo.get(id)
    if (!account) throw new ApiError('ACCOUNT_NOT_FOUND', '账号不存在', 'notFound', 404)
    this.#vault.delete(id)
    this.#repo.delete(id)
  }
}
