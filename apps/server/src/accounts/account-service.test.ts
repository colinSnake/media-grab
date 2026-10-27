import { describe, expect, it } from 'vitest'
import { defaultAppConfig } from '@mediagrab/shared'
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
  const fake = new FakeFetch().route('/x/web-interface/nav', { json: response })
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
