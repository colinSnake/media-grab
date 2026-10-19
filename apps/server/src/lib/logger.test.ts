import { describe, expect, it } from 'vitest'
import {
  maskSecret,
  redactCookie,
  redactHeaders,
  redactTicket,
  redactUrl,
} from './logger.js'

/**
 * 脱敏是红线能力（RISK §1.5 / NFR-03）：日志里出现 SESSDATA 明文等于泄露密码。
 * 这里用"检索明文零命中"的方式断言，而不是只看输出长得像不像掩码。
 */
describe('日志脱敏', () => {
  const SESSDATA = 'abcdef123456%2C789xyz'
  const BILI_JCT = 'deadbeefcafe'
  const BUVID3 = 'FD9CDD64-6989-934F-6066-9C59639D10CA75158infoc'
  const COOKIE = `buvid3=${BUVID3}; buvid4=BBB; b_nut=1792139575; SESSDATA=${SESSDATA}; bili_jct=${BILI_JCT}`

  it('凭据类 Cookie 值不得以明文出现在输出里', () => {
    const output = redactCookie(COOKIE)
    expect(output).not.toContain(SESSDATA)
    expect(output).not.toContain(BILI_JCT)
    expect(output).toContain('SESSDATA=')
  })

  it('设备指纹保留前 4 位（排障需要），其余遮罩', () => {
    const output = redactCookie(COOKIE)
    expect(output).toContain('buvid3=FD9C')
    expect(output).not.toContain(BUVID3)
  })

  it('票据与未登记的 Cookie 一律整体遮罩', () => {
    const output = redactCookie('bili_ticket=eyJhbGciOiJIUzI1NiJ9.payload.sig; foo=bar')
    expect(output).not.toContain('eyJhbGciOiJIUzI1NiJ9')
    expect(output).not.toContain('bar')
    expect(output).toContain('bili_ticket=')
  })

  it('空 Cookie 安全返回空串', () => {
    expect(redactCookie(undefined)).toBe('')
    expect(redactCookie('')).toBe('')
  })

  it('请求头脱敏只动 Cookie', () => {
    const headers = redactHeaders({ Cookie: COOKIE, Referer: 'https://www.bilibili.com/' })
    expect(headers.Cookie).not.toContain(SESSDATA)
    expect(headers.Referer).toBe('https://www.bilibili.com/')
  })

  it('URL 里的签名参数被遮罩，其余参数保留', () => {
    const url = redactUrl(
      'https://api.bilibili.com/x/player/wbi/playurl?bvid=BV1GJ411x7h7&w_rid=abc123&csrf=secret&fnval=4048',
    )
    expect(url).not.toContain('abc123')
    expect(url).not.toContain('secret')
    expect(url).toContain('bvid=BV1GJ411x7h7')
    expect(url).toContain('fnval=4048')
  })

  it('maskSecret / redactTicket 行为固定', () => {
    // 保留前 keep 位，其余用星号（最多 8 个，避免超长值把日志撑爆）
    expect(maskSecret('1234567890', 4)).toBe('1234******')
    expect(maskSecret('ab', 4)).toBe('**')
    expect(maskSecret('', 4)).toBe('')
    expect(redactTicket('eyJhbGciOiJIUzI1NiJ9.abc.def')).toBe('eyJhbG********')
    expect(redactTicket(null)).toBe('')
  })
})
