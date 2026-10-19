import { describe, expect, it } from 'vitest'
import {
  AUDIO_QN,
  BILI_CODE,
  BILI_MESSAGE,
  FNVAL_MAX,
  QN,
  accessLevelOf,
  accessibleQualities,
  audioAvailabilityFor,
  availabilityFor,
  biliMessageOf,
  canAccess,
  classifyBiliCode,
  isNonRetryableAuthCode,
  isRiskControlCode,
  pickAudioStream,
  pickStream,
  streamUrl,
  type AccountSession,
  type DashStream,
} from './bili.js'

/** 免登（本项目默认工作模式） */
const ANON: AccountSession = { loggedIn: false, vip: false }
/** 已登录但非大会员 */
const FREE: AccountSession = { loggedIn: true, vip: false }
/** 大会员 */
const MEMBER: AccountSession = { loggedIn: true, vip: true }

describe('档位可用性：以实际交付为准（免登优先）', () => {
  // 匿名实测 BV1GJ411x7h7：声明 5 档，实际只交付 360P/480P
  const ADVERTISED = [112, 80, 64, 32, 16]
  const DELIVERED = [16, 32]

  it('只有实际交付的档位算可用，不被虚报迷惑', () => {
    const list = availabilityFor(ADVERTISED, DELIVERED, ANON)
    expect(list.filter((item) => item.available).map((item) => item.qn)).toEqual([32, 16])
  })

  it('声明支持但未交付的档位标注登录/会员，绝不标为可用', () => {
    const list = availabilityFor(ADVERTISED, DELIVERED, ANON)
    const byQn = new Map(list.map((item) => [item.qn, item] as const))
    expect(byQn.get(64)?.state).toBe('need-login')
    expect(byQn.get(80)?.state).toBe('need-login')
    expect(byQn.get(112)?.state).toBe('need-vip')
    expect(byQn.get(112)?.reason).toBe('需要大会员')
  })

  it('已是大会员仍未交付的档位，如实标注服务端未提供', () => {
    const list = availabilityFor(ADVERTISED, DELIVERED, MEMBER)
    const byQn = new Map(list.map((item) => [item.qn, item] as const))
    expect(byQn.get(112)?.state).toBe('not-delivered')
    expect(byQn.get(112)?.reason).toBe('服务端未提供该档位')
  })

  it('实际交付的档位一律可用（哪怕矩阵认为需要会员）', () => {
    const list = availabilityFor([120], [120], ANON)
    expect(list[0]?.available).toBe(true)
    expect(list[0]?.reason).toBe('')
  })

  it('accessibleQualities 只返回实际交付项，且按档位降序', () => {
    expect(accessibleQualities(ADVERTISED, DELIVERED, ANON)).toEqual([32, 16])
    expect(accessibleQualities(ADVERTISED, [112, 80, 64, 32, 16], MEMBER)).toEqual([
      112, 80, 64, 32, 16,
    ])
  })

  it('矩阵未收录的档位按阈值保守推断', () => {
    expect(accessLevelOf(16)).toBe('anonymous')
    expect(accessLevelOf(999)).toBe('vip')
  })

  it('480P 匿名可用，1080P+ 需大会员', () => {
    expect(canAccess(QN.Q480P, ANON)).toBe(true)
    expect(canAccess(QN.Q1080P_PLUS, ANON)).toBe(false)
    expect(canAccess(QN.Q1080P_PLUS, FREE)).toBe(false)
    expect(canAccess(QN.Q1080P_PLUS, MEMBER)).toBe(true)
  })
})

describe('fnval 与错误码分类', () => {
  it('FNVAL_MAX 一次覆盖 dash/AV1/8K/杜比/4K/HDR', () => {
    expect(FNVAL_MAX).toBe(4048)
  })

  it('风控类错误应退避重试', () => {
    expect(isRiskControlCode(BILI_CODE.RISK_BLOCKED)).toBe(true)
    expect(isRiskControlCode(BILI_CODE.TOO_FREQUENT)).toBe(true)
    expect(isRiskControlCode(BILI_CODE.RISK_VOUCHER)).toBe(true)
    expect(isRiskControlCode(BILI_CODE.NOT_FOUND)).toBe(false)
  })

  it('账号与权限类错误不重试', () => {
    expect(isNonRetryableAuthCode(BILI_CODE.NOT_LOGIN)).toBe(true)
    expect(isNonRetryableAuthCode(BILI_CODE.NO_PERMISSION)).toBe(true)
    expect(isNonRetryableAuthCode(BILI_CODE.RISK_BLOCKED)).toBe(false)
  })
})

describe('取流地址与选流', () => {
  const streams: DashStream[] = [
    { id: 80, baseUrl: 'https://a/avc.m4s', codecid: 7 },
    { id: 80, base_url: 'https://a/hevc.m4s', codecid: 12 },
    { id: 80, codecid: 13 },
  ]

  it('优先 base_url，其次 baseUrl，都没有则 undefined', () => {
    expect(streamUrl(streams[1] as DashStream)).toBe('https://a/hevc.m4s')
    expect(streamUrl(streams[0] as DashStream)).toBe('https://a/avc.m4s')
    expect(streamUrl(streams[2] as DashStream)).toBeUndefined()
  })

  it('按编码优先级挑视频流', () => {
    expect(pickStream(streams, [12, 7])?.codecid).toBe(12)
    expect(pickStream(streams, [7])?.codecid).toBe(7)
  })

  it('按音质优先级挑音频流', () => {
    const audio: DashStream[] = [{ id: AUDIO_QN.K64 }, { id: AUDIO_QN.K192 }]
    expect(pickAudioStream(audio, [30280, 30216])?.id).toBe(AUDIO_QN.K192)
  })
})

describe('音频档位可用性：同样以实际交付为准', () => {
  const PLAIN = [AUDIO_QN.K64, AUDIO_QN.K132, AUDIO_QN.K192]

  /** 便于按 id 查档位 */
  function byId(list: ReturnType<typeof audioAvailabilityFor>) {
    return new Map(list.map((item) => [item.id, item] as const))
  }

  it('候选固定为 5 档且按 id 降序', () => {
    expect(audioAvailabilityFor([], ANON).map((item) => item.id)).toEqual([
      AUDIO_QN.K192,
      AUDIO_QN.HIRES_FLAC,
      AUDIO_QN.DOLBY_ATMOS,
      AUDIO_QN.K132,
      AUDIO_QN.K64,
    ])
  })

  it('实际交付的 64K/132K/192K 全部可用', () => {
    const audio = byId(audioAvailabilityFor(PLAIN, ANON))
    for (const id of PLAIN) {
      expect(audio.get(id)?.available).toBe(true)
      expect(audio.get(id)?.state).toBe('available')
      expect(audio.get(id)?.reason).toBe('')
    }
  })

  it('匿名未交付：有权档位标 not-delivered，会员档位标 need-vip', () => {
    const audio = byId(audioAvailabilityFor([], ANON))
    for (const id of PLAIN) {
      expect(audio.get(id)?.state).toBe('not-delivered')
      expect(audio.get(id)?.available).toBe(false)
      expect(audio.get(id)?.reason).toBe('服务端未提供该档位')
    }
    for (const id of [AUDIO_QN.DOLBY_ATMOS, AUDIO_QN.HIRES_FLAC]) {
      expect(audio.get(id)?.state).toBe('need-vip')
      expect(audio.get(id)?.available).toBe(false)
      expect(audio.get(id)?.reason).toBe('需要大会员')
      expect(audio.get(id)?.access).toBe('vip')
    }
  })

  it('大会员未交付的 Hi-Res 如实标注 not-delivered', () => {
    const audio = byId(audioAvailabilityFor([AUDIO_QN.DOLBY_ATMOS], MEMBER))
    expect(audio.get(AUDIO_QN.DOLBY_ATMOS)?.available).toBe(true)
    expect(audio.get(AUDIO_QN.HIRES_FLAC)?.state).toBe('not-delivered')
    expect(audio.get(AUDIO_QN.HIRES_FLAC)?.reason).toBe('服务端未提供该档位')
  })
})

describe('错误码分类与中文文案（NFR-07：集中在 shared）', () => {
  it('风控 / 账号 / 权限 / 不存在 各归各类', () => {
    expect(classifyBiliCode(-412)).toBe('risk')
    expect(classifyBiliCode(-509)).toBe('risk')
    expect(classifyBiliCode(-352)).toBe('risk')
    expect(classifyBiliCode(-101)).toBe('auth')
    expect(classifyBiliCode(-102)).toBe('auth')
    expect(classifyBiliCode(-111)).toBe('auth')
    expect(classifyBiliCode(-403)).toBe('permission')
    expect(classifyBiliCode(-10403)).toBe('permission')
    expect(classifyBiliCode(-404)).toBe('notFound')
  })

  it('未知码归为 fatal（0 表示成功，也返回 fatal，调用方应先判断 0）', () => {
    expect(classifyBiliCode(-1)).toBe('fatal')
    expect(classifyBiliCode(62002)).toBe('fatal')
    expect(classifyBiliCode(0)).toBe('fatal')
  })

  it('必收录的错误码都有中文文案', () => {
    for (const code of [0, -101, -102, -111, -403, -404, -412, -509, -352, -10403]) {
      expect(BILI_MESSAGE[code] ?? '').not.toBe('')
      expect(biliMessageOf(code)).toBe(BILI_MESSAGE[code])
    }
    expect(biliMessageOf(-412)).toBe('请求被风控拦截，请稍后退避重试')
    expect(biliMessageOf(-101)).toBe('账号未登录')
    expect(biliMessageOf(0)).toBe('成功')
    expect(BILI_MESSAGE[-1]).toBeUndefined()
  })

  it('未收录码走 fallback 或通用文案', () => {
    expect(biliMessageOf(-9999)).toBe('B站接口返回错误（code=-9999）')
    expect(biliMessageOf(-9999, '解析失败，请稍后重试')).toBe('解析失败，请稍后重试')
  })
})
