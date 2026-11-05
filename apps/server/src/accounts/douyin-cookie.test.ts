import { describe, expect, it } from 'vitest'
import { normalizeDouyinCookie, normalizeXiaohongshuCookie, normalizeYouTubeCookie, platformCookieExpired } from './douyin-cookie.js'

describe('normalizeDouyinCookie', () => {
  it('converts a pasted Cookie header to a Netscape cookie file', () => {
    expect(normalizeDouyinCookie('sessionid=abc; msToken=xyz')).toContain('.douyin.com\tTRUE\t/\tFALSE\t0\tsessionid\tabc')
  })

  it('keeps only Douyin domains from a Netscape export', () => {
    const result = normalizeDouyinCookie('# Netscape HTTP Cookie File\n.example.com\tTRUE\t/\tFALSE\t0\tother\tno\n.douyin.com\tTRUE\t/\tFALSE\t0\tsessionid\tyes\n')
    expect(result).toContain('\t sessionid\t'.replace(' ', ''))
    expect(result).not.toContain('other')
  })

  it('rejects empty or unrecognized cookie content', () => {
    expect(() => normalizeDouyinCookie('')).toThrow('Cookie 不能为空')
    expect(() => normalizeDouyinCookie('not-a-cookie')).toThrow('无法识别抖音 Cookie')
  })

  it('normalizes Xiaohongshu cookies only for Xiaohongshu domains', () => {
    const result = normalizeXiaohongshuCookie('web_session=secret; a1=token')
    expect(result).toContain('.xiaohongshu.com\tTRUE\t/\tFALSE\t0\tweb_session\tsecret')
    expect(() => normalizeXiaohongshuCookie('# Netscape HTTP Cookie File\n.douyin.com\tTRUE\t/\tFALSE\t0\tsid\tvalue')).toThrow('没有找到小红书域名')
  })

  it('retains YouTube and Google HttpOnly cookies but excludes foreign domains', () => {
    const input = '# Netscape HTTP Cookie File\n#HttpOnly_.youtube.com\tTRUE\t/\tTRUE\t0\tSID\tsecret\n.google.com\tTRUE\t/\tTRUE\t0\tSAPISID\tvalid\n.evil-google.com\tTRUE\t/\tFALSE\t0\tSID\tbad\n.douyin.com\tTRUE\t/\tFALSE\t0\tsessionid\tbad\n'
    const result = normalizeYouTubeCookie(input)
    expect(result).toContain('#HttpOnly_.youtube.com\tTRUE\t/\tTRUE\t0\tSID\tsecret')
    expect(result).toContain('.google.com\tTRUE\t/\tTRUE\t0\tSAPISID\tvalid')
    expect(result).not.toContain('evil-google.com')
    expect(result).not.toContain('.douyin.com')
    expect(() => normalizeYouTubeCookie('# Netscape HTTP Cookie File\n.douyin.com\tTRUE\t/\tFALSE\t0\tsid\tbad')).toThrow('没有找到YouTube域名')
  })

  it('accepts a YouTube Cookie header without storing unrelated fields', () => {
    expect(normalizeYouTubeCookie('Cookie: SID=secret; SAPISID=token')).toContain('.youtube.com\tTRUE\t/\tFALSE\t0\tSID\tsecret')
  })
})


describe('platformCookieExpired', () => {
  const now = 2_000_000_000_000
  const entry = (domain: string, name: string, expiry: number | string) => `${domain}\tTRUE\t/\tTRUE\t${expiry}\t${name}\tsecret`
  const file = (...entries: string[]) => `# Netscape HTTP Cookie File\n${entries.join('\n')}\n`

  it.each([
    ['douyin', '.douyin.com', 'sessionid'],
    ['xiaohongshu', '#HttpOnly_.xiaohongshu.com', 'web_session'],
    ['youtube', '.youtube.com', 'SID'],
  ] as const)('detects expired %s authentication even with live tracking cookies', (platform, domain, name) => {
    expect(platformCookieExpired(platform, file(entry(domain, name, now / 1_000), entry(domain, 'tracking', now / 1_000 + 600)), now)).toBe(true)
    expect(platformCookieExpired(platform, file(entry(domain, name, now / 1_000 + 1)), now)).toBe(false)
  })

  it('keeps alternative live authentication and sessions with unknown deadlines', () => {
    for (const alternative of ['LOGIN_INFO', '__Secure-3PSID', 'SAPISID', '__Secure-1PAPISID']) {
      for (const expiry of [0, 'invalid', 2_000_000_001]) {
        const cookies = file(entry('.youtube.com', 'SID', 1), entry('.youtube.com', alternative, expiry))
        expect(platformCookieExpired('youtube', cookies, now)).toBe(false)
      }
    }
    expect(platformCookieExpired('douyin', 'sessionid=header-without-expiry', now)).toBe(false)
    expect(platformCookieExpired('douyin', file(), now)).toBe(false)
  })

  it('expires all dated entries when no known authentication cookie exists', () => {
    expect(platformCookieExpired('douyin', file(entry('.douyin.com', 'other', 1)), now)).toBe(true)
    expect(platformCookieExpired('douyin', file(entry('.foreign.com', 'sessionid', 1)), now)).toBe(false)
  })
})
