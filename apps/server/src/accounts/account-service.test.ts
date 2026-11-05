import { describe, expect, it, vi } from 'vitest'
import { credentialPreviewSchema, defaultAppConfig } from '@mediagrab/shared'
import { AccountService } from './account-service.js'
import { CredentialVault } from './credential-vault.js'
import { Database } from '../store/db.js'
import { AccountRepository } from '../store/repositories.js'
import { BiliHttp } from '../bili/http.js'
import { BiliRateLimiter } from '../lib/token-bucket.js'
import { FakeFetch } from '../testing/fake-fetch.js'

const NAV_LOGGED_IN = {
  code: 0,
  message: 'OK',
  data: { isLogin: true, mid: 123, uname: '测试用户', vipStatus: 1, vipType: 2 },
}

const NAV_LOGGED_OUT = {
  code: -101,
  message: '账号未登录',
  data: { isLogin: false, wbi_img: { img_url: 'https://i0.hdslb.com/wbi/a.png', sub_url: 'https://i0.hdslb.com/wbi/b.png' } },
}

function setup(response: unknown) {
  const fake = new FakeFetch().route('/x/web-interface/nav', () => ({ json: typeof response === 'function' ? response() : response }))
  const db = Database.open(':memory:')
  const http = new BiliHttp({
    fetchImpl: fake.fetchImpl,
    limiter: new BiliRateLimiter({ apiMinIntervalMs: 0, passportMinIntervalMs: 0 }),
    sleep: async () => {},
  })
  const repo = new AccountRepository(db)
  const vault = CredentialVault.inMemory()
  const service = new AccountService({ repo, vault, http, deviceCookieProvider: () => 'buvid3=DEVICE' })
  return { db, fake, repo, vault, service }
}

describe('AccountService', () => {
  it('保存和清除抖音 Cookie 时只暴露配置状态', () => {
    const { db, service } = setup(NAV_LOGGED_IN)
    expect(service.douyinCookieConfigured()).toBe(false)
    service.saveDouyinCookie('sessionid=secret')
    expect(service.douyinCookieConfigured()).toBe(true)
    expect(service.douyinCookie()).toContain('sessionid')
    service.clearDouyinCookie()
    expect(service.douyinCookieConfigured()).toBe(false)
    expect(service.douyinCookie()).toBeUndefined()
    db.close()
  })

  it('保存和清除小红书 Cookie 时只暴露配置状态', () => {
    const { db, service } = setup(NAV_LOGGED_IN)
    expect(service.xiaohongshuCookieConfigured()).toBe(false)
    service.saveXiaohongshuCookie('web_session=secret')
    expect(service.xiaohongshuCookieConfigured()).toBe(true)
    expect(service.xiaohongshuCookie()).toContain('web_session')
    service.clearXiaohongshuCookie()
    expect(service.xiaohongshuCookieConfigured()).toBe(false)
    expect(service.xiaohongshuCookie()).toBeUndefined()
    db.close()
  })

  it('uses the encrypted vault for YouTube Cookie and only exposes configuration status', () => {
    const { db, vault, service } = setup(NAV_LOGGED_IN)
    service.saveCookie('youtube', 'SID=secret')
    expect(service.cookieConfigured('youtube')).toBe(true)
    expect(service.cookie('youtube')).toContain('SID\tsecret')
    expect(vault.get('platform:youtube')).toContain('SID\tsecret')
    service.clearCookie('youtube')
    expect(service.cookieConfigured('youtube')).toBe(false)
    db.close()
  })

  it('导入并验证成功，只返回脱敏账号摘要且请求合并设备 Cookie', async () => {
    const { db, fake, service } = setup(NAV_LOGGED_IN)
    const result = await service.importBili('我的 B站', 'SESSDATA=secret; bili_jct=csrf; ignored=x')
    expect(result).toMatchObject({ label: '我的 B站', displayName: '测试用户', loggedIn: true, vip: true, active: true })
    expect(JSON.stringify(result)).not.toContain('secret')
    expect(credentialPreviewSchema.parse(result.credentialPreview)).toBe(result.credentialPreview)
    expect(service.list().find((account) => account.id === result.id)?.credentialPreview).toBe(result.credentialPreview)
    expect(fake.calls[0]?.headers.cookie).toContain('buvid3=DEVICE')
    expect(fake.calls[0]?.headers.cookie).toContain('SESSDATA=secret')
    expect(service.cookieHeader()).toContain('SESSDATA=secret')
    db.close()
  })

  it('验证另一个账号失败时不改变当前账号', async () => {
    const { db, repo, vault, service } = setup(NAV_LOGGED_OUT)
    const first = { id: 'first', platform: 'bilibili' as const, label: '一', displayName: '', status: 'active' as const, loggedIn: true, vip: false, active: true, lastVerifiedAt: null, updatedAt: 1 }
    const second = { id: 'second', platform: 'bilibili' as const, label: '二', displayName: '', status: 'active' as const, loggedIn: true, vip: false, active: false, lastVerifiedAt: null, updatedAt: 2 }
    repo.save(first); repo.save(second); vault.set(first.id, 'SESSDATA=first'); vault.set(second.id, 'SESSDATA=second')
    await expect(service.activate(second.id)).rejects.toMatchObject({ code: 'ACCOUNT_NOT_LOGGED_IN' })
    expect(repo.get(first.id)?.active).toBe(true)
    expect(repo.get(second.id)?.active).toBe(false)
    expect(vault.get(second.id)).toBeNull()
    db.close()
  })

  it('无效 Cookie 导入不会留下凭据或账号记录', async () => {
    const { db, repo, service } = setup(NAV_LOGGED_IN)
    await expect(service.importBili('坏账号', 'foo=bar')).rejects.toMatchObject({ code: 'INVALID_ACCOUNT_COOKIE' })
    expect(repo.list()).toHaveLength(0)
    db.close()
  })
})


describe('expired account credentials', () => {
  it.each([
    ['douyin', '.douyin.com', 'sessionid'],
    ['xiaohongshu', '.xiaohongshu.com', 'web_session'],
    ['youtube', '.youtube.com', 'SID'],
  ] as const)('clears %s saved ciphertext and vault entry once authentication expires', (platform, domain, name) => {
    const { db, vault, service } = setup(NAV_LOGGED_IN)
    const clock = vi.spyOn(Date, 'now').mockReturnValue(2_000_000_000_000)
    try {
      service.saveCookie(platform, `# Netscape HTTP Cookie File\n${domain}\tTRUE\t/\tTRUE\t2000000001\t${name}\tsecret\n${domain}\tTRUE\t/\tTRUE\t0\ttracking\tretained\n`)
      expect(service.cookieStatus(platform).configured).toBe(true)
      clock.mockReturnValue(2_000_000_001_000)
      expect(service.cookieStatus(platform)).toEqual({ configured: false, credentialPreview: null })
      expect(vault.get(`platform:${platform}`)).toBeNull()
      expect(service.cookie(platform)).toBeUndefined()
    } finally {
      clock.mockRestore()
      db.close()
    }
  })

  it('rejects an expired replacement without discarding saved credentials', () => {
    const { db, service } = setup(NAV_LOGGED_IN)
    service.saveCookie('douyin', 'sessionid=still-valid')
    const original = service.cookieStatus('douyin')
    expect(() => service.saveCookie('douyin', '# Netscape HTTP Cookie File\n.douyin.com\tTRUE\t/\tTRUE\t1\tsessionid\texpired\n')).toThrow(expect.objectContaining({ code: 'COOKIE_EXPIRED' }))
    expect(service.cookieStatus('douyin')).toEqual(original)
    db.close()
  })

  it('clears expired Bilibili credentials and prevents their reappearance in account summaries', async () => {
    let response = NAV_LOGGED_IN as unknown
    const { db, vault, service } = setup(() => response)
    const imported = await service.importBili('账号', 'SESSDATA=secret')
    response = NAV_LOGGED_OUT
    await expect(service.verify(imported.id)).rejects.toMatchObject({ code: 'ACCOUNT_NOT_LOGGED_IN' })
    expect(vault.get(imported.id)).toBeNull()
    expect(service.list()).toEqual([expect.objectContaining({ id: imported.id, status: 'needs-login', loggedIn: false, vip: false, credentialPreview: null })])
    expect(service.cookieHeader()).toBeUndefined()
    await expect(service.verify(imported.id)).rejects.toMatchObject({ code: 'ACCOUNT_CREDENTIAL_MISSING' })
    db.close()
  })

  it('keeps credentials on transient network failure', async () => {
    let fail = false
    const { db, vault, service } = setup(() => {
      if (fail) throw new Error('temporary network failure')
      return NAV_LOGGED_IN
    })
    const imported = await service.importBili('账号', 'SESSDATA=secret')
    fail = true
    await expect(service.verify(imported.id)).rejects.toBeDefined()
    expect(vault.get(imported.id)).toBe('SESSDATA=secret')
    expect(service.list()[0]).toMatchObject({ status: 'active', credentialPreview: imported.credentialPreview })
    db.close()
  })

  it('does not resurrect an account deleted during background verification', async () => {
    let onResponse = () => {}
    const { db, repo, service } = setup(() => { onResponse(); return NAV_LOGGED_IN })
    const imported = await service.importBili('账号', 'SESSDATA=secret')
    onResponse = () => service.remove(imported.id)
    await expect(service.verify(imported.id)).rejects.toMatchObject({ code: 'ACCOUNT_CREDENTIAL_MISSING' })
    expect(repo.get(imported.id)).toBeNull()
    db.close()
  })

  it('preserves a newer account selection while an older account is being verified', async () => {
    let onResponse = () => {}
    const { db, repo, service } = setup(() => { onResponse(); return NAV_LOGGED_IN })
    const first = await service.importBili('一', 'SESSDATA=first')
    const second = await service.importBili('二', 'SESSDATA=second')
    onResponse = () => repo.setActive('bilibili', first.id)
    expect(await service.verify(second.id)).toMatchObject({ active: false })
    expect(service.activeBili()?.id).toBe(first.id)
    db.close()
  })
})
