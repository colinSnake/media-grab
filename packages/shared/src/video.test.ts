import { describe, expect, it } from 'vitest'
import {
  BV_PATTERN,
  bvidSchema,
  parseBiliInput,
  parseRequestSchema,
  playurlResultSchema,
  videoPageSchema,
  videoViewSchema,
  type BiliInput,
} from './video.js'

const BV = 'BV1GJ411x7h7'
/** 免登（本项目默认工作模式） */
const ANON = { loggedIn: false, vip: false }

/** 断言解析成功并取出归一化结果 */
function ok(raw: string): BiliInput {
  const res = parseBiliInput(raw)
  if (!res.ok) throw new Error(`期望解析成功，但失败了：${res.reason}`)
  return res.value
}

/** 断言解析失败并取出原因文案 */
function fail(raw: string): string {
  const res = parseBiliInput(raw)
  if (res.ok) throw new Error(`期望解析失败，但成功了：${JSON.stringify(res.value)}`)
  return res.reason
}

describe('parseBiliInput：纯 ID 输入', () => {
  it('识别 BV 号并裁剪首尾空白', () => {
    expect(ok(`  ${BV}\n`)).toEqual({ kind: 'bvid', bvid: BV })
  })

  it('BV_PATTERN 只接受 BV + 10 位（前缀大小写敏感）', () => {
    expect(BV_PATTERN.test(BV)).toBe(true)
    expect(BV_PATTERN.test('BV1GJ411x7h')).toBe(false) // 少一位
    expect(BV_PATTERN.test(`bv${BV.slice(2)}`)).toBe(false) // 小写前缀
    expect(bvidSchema.safeParse(BV).success).toBe(true)
    expect(bvidSchema.safeParse('av170001').success).toBe(false)
  })

  it('识别 av 号（大小写不敏感）', () => {
    expect(ok('av170001')).toEqual({ kind: 'avid', avid: 170001 })
    expect(ok('AV170001')).toEqual({ kind: 'avid', avid: 170001 })
  })
})

describe('parseBiliInput：bilibili 链接', () => {
  it('完整链接（含 ?p=2 与其它参数）', () => {
    expect(ok(`https://www.bilibili.com/video/${BV}/?p=2&t=1`)).toEqual({
      kind: 'bvid',
      bvid: BV,
      page: 2,
    })
  })

  it('兼容复制后的 Markdown 转义查询参数', () => {
    expect(ok('https://www.bilibili.com/video/BV149jo6nEYB/?t=35.8\\&vd_source=share')).toEqual({
      kind: 'bvid',
      bvid: 'BV149jo6nEYB',
    })
  })

  it('无 scheme 的链接同样可识别', () => {
    expect(ok('bilibili.com/video/av170001')).toEqual({ kind: 'avid', avid: 170001 })
  })

  it('av 链接与 m 站链接', () => {
    expect(ok('https://www.bilibili.com/video/av170001')).toEqual({ kind: 'avid', avid: 170001 })
    expect(ok(`https://m.bilibili.com/video/${BV}`)).toEqual({ kind: 'bvid', bvid: BV })
  })

  it('bilibili.com 根域与 av 链接的 ?p= 也生效', () => {
    expect(ok(`https://bilibili.com/video/${BV}?p=7`)).toEqual({
      kind: 'bvid',
      bvid: BV,
      page: 7,
    })
  })

  it('?p= 不是正整数时 page 为 undefined', () => {
    for (const raw of [
      `https://www.bilibili.com/video/${BV}?p=0`,
      `https://www.bilibili.com/video/${BV}?p=-1`,
      `https://www.bilibili.com/video/${BV}?p=1.5`,
      `https://www.bilibili.com/video/${BV}?p=abc`,
      `https://www.bilibili.com/video/${BV}`,
    ]) {
      const value = ok(raw)
      expect(value.kind).toBe('bvid')
      expect(value.page).toBeUndefined()
    }
  })

  it('带非 ASCII 查询串的无 scheme 链接仍可识别', () => {
    expect(ok(`bilibili.com/video/${BV}?t=中文`)).toEqual({ kind: 'bvid', bvid: BV })
  })

  it('b23.tv 短链只识别为 short，交由服务端出网解析', () => {
    expect(ok('https://b23.tv/AbCdEfG?p=3')).toEqual({
      kind: 'short',
      url: 'https://b23.tv/AbCdEfG?p=3',
      page: 3,
    })
    const bare = ok('b23.tv/AbCdEfG')
    expect(bare.kind).toBe('short')
    expect(bare.page).toBeUndefined()
  })
})

describe('parseBiliInput：失败原因文案', () => {
  it('空输入', () => {
    expect(fail('')).toBe('请输入视频链接、BV 号或 av 号')
    expect(fail('   \n\t ')).toBe('请输入视频链接、BV 号或 av 号')
  })

  it('乱码：无法识别的输入', () => {
    expect(fail('!!!@@@###')).toBe('无法识别的输入，支持 BV 号 / av 号 / 视频链接 / b23.tv 短链')
    expect(fail('这是一串乱码')).toBe(
      '无法识别的输入，支持 BV 号 / av 号 / 视频链接 / b23.tv 短链',
    )
  })

  it('非 B站站点：给出具体站点名', () => {
    expect(fail('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe(
      '不支持的站点：www.youtube.com（仅支持 bilibili.com / b23.tv）',
    )
    expect(fail('youtube.com/watch?v=dQw4w9WgXcQ')).toBe(
      '不支持的站点：youtube.com（仅支持 bilibili.com / b23.tv）',
    )
    // 后缀伪装：bilibili.com.evil.com 不是 bilibili.com 的子域
    expect(fail(`https://bilibili.com.evil.com/video/${BV}`)).toBe(
      '不支持的站点：bilibili.com.evil.com（仅支持 bilibili.com / b23.tv）',
    )
  })

  it('是 B站链接但路径里没有视频 ID', () => {
    const reason = '链接里没有找到视频 ID（形如 /video/BV... 或 /video/av...）'
    expect(fail('https://www.bilibili.com/bangumi/play/ss12345')).toBe(reason)
    expect(fail('https://space.bilibili.com/12345')).toBe(reason)
    expect(fail(`https://www.bilibili.com/video/BV1GJ411x7h`)).toBe(reason) // BV 少一位
  })
})

describe('接口响应 schema', () => {
  it('videoPageSchema 的 part/duration 有默认值', () => {
    const page = videoPageSchema.parse({ cid: 1, page: 1 })
    expect(page.part).toBe('')
    expect(page.duration).toBe(0)
  })

  it('videoViewSchema 允许 data 缺失，且内部字段有默认值', () => {
    expect(videoViewSchema.safeParse({ code: -404, message: 'not found' }).success).toBe(true)
    const view = videoViewSchema.parse({
      code: 0,
      data: { bvid: BV, aid: 1, cid: 2, owner: { mid: 3 } },
    })
    expect(view.data?.title).toBe('')
    expect(view.data?.pic).toBe('')
    expect(view.data?.duration).toBe(0)
    expect(view.data?.owner.name).toBe('')
    expect(view.data?.pages).toEqual([])
  })

  it('parseRequestSchema 要求非空 input，page 必须为正整数', () => {
    expect(parseRequestSchema.safeParse({ input: '' }).success).toBe(false)
    expect(parseRequestSchema.safeParse({ input: BV }).success).toBe(true)
    expect(parseRequestSchema.safeParse({ input: BV, page: 0 }).success).toBe(false)
    expect(parseRequestSchema.safeParse({ input: BV, page: 2 }).success).toBe(true)
  })

  it('playurlResultSchema：durationSec 默认 0，流地址不能为空', () => {
    const base = {
      bvid: BV,
      cid: 1,
      session: ANON,
      qualities: [],
      audioQualities: [],
      video: [{ id: 80, url: 'https://a/v.m4s' }],
      audio: [],
      urlTtlSec: 120,
    }
    const parsed = playurlResultSchema.parse(base)
    expect(parsed.durationSec).toBe(0)
    expect(parsed.video[0]?.backupUrls).toEqual([])
    expect(
      playurlResultSchema.safeParse({ ...base, video: [{ id: 80, url: '' }] }).success,
    ).toBe(false)
  })
})
