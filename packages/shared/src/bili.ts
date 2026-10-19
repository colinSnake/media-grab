import { z } from 'zod'

/**
 * B站视频清晰度代码（qn）。
 *
 * 重要：dash 模式下 qn 参数**不生效**，必须按返回的 `dash.video[].id` 选流。
 * 因此固定请求 `qn=127&fnval=FNVAL_MAX`（位掩码全开）一次性拿到服务端可见的全部档位，
 * 再按当前身份（匿名 / 登录 / 大会员）筛选 —— 而不是靠"请求时指定 qn"来期待结果。
 *
 * 档位的可得性由 B站服务端鉴权决定，不是本项目的开关：
 * 匿名请求通常只能拿到 240P/360P/480P（部分视频 720P）。
 * 详见 docs/RISK-CONTROL.md §2。
 */
export const QN = {
  Q240P: 6,
  Q360P: 16,
  Q480P: 32,
  Q720P: 64,
  Q720P60: 74,
  Q1080P: 80,
  Q1080P_PLUS: 112,
  Q1080P60: 116,
  Q4K: 120,
  QHDR: 125,
  QDOLBY_VISION: 126,
  Q8K: 127,
} as const

export type QualityCode = (typeof QN)[keyof typeof QN]

/** 身份等级：anonymous 免登可得、login 需登录、vip 需大会员 */
export const accessLevelSchema = z.enum(['anonymous', 'login', 'vip'])

/** 获取某个档位所需的身份等级 */
export type AccessLevel = z.infer<typeof accessLevelSchema>

/** 账号登录态；仅用于筛选候选档位，实际可用性一律以服务端实际交付为准 */
export const accountSessionSchema = z.object({ loggedIn: z.boolean(), vip: z.boolean() })

export type AccountSession = z.infer<typeof accountSessionSchema>

export interface QualityMeta {
  qn: QualityCode
  label: string
  access: AccessLevel
  /** 4K 需要额外带上 fourk=1 */
  needsFourk?: boolean
}

/**
 * 档位 → 所需身份。
 * 注意这里的语义是「服务端要求什么」，而不是「我们要求用户登录」：
 * 匿名可得档位一律可直接下载，其余档位仅在 UI 上标注为登录后解锁，不阻塞其它档位。
 */
export const QUALITY_META: readonly QualityMeta[] = [
  { qn: QN.Q240P, label: '240P 极速', access: 'anonymous' },
  { qn: QN.Q360P, label: '360P 流畅', access: 'anonymous' },
  { qn: QN.Q480P, label: '480P 清晰', access: 'anonymous' },
  // 720P：web 端 UI 要求登录，但直接请求接口匿名常可获取。这里保守归为 login，
  // 实际是否可选以服务端返回的 accept_quality 为准（RISK §2.2）。
  { qn: QN.Q720P, label: '720P 高清', access: 'login' },
  { qn: QN.Q720P60, label: '720P60 高帧率', access: 'login' },
  { qn: QN.Q1080P, label: '1080P 高清', access: 'login' },
  { qn: QN.Q1080P_PLUS, label: '1080P+ 高码率', access: 'vip' },
  { qn: QN.Q1080P60, label: '1080P60 高帧率', access: 'vip' },
  { qn: QN.Q4K, label: '4K 超清', access: 'vip', needsFourk: true },
  { qn: QN.QHDR, label: 'HDR 真彩', access: 'vip' },
  { qn: QN.QDOLBY_VISION, label: '杜比视界', access: 'vip' },
  { qn: QN.Q8K, label: '8K 超高清', access: 'vip' },
] as const

const QUALITY_BY_QN: ReadonlyMap<number, QualityMeta> = new Map(
  QUALITY_META.map((meta) => [meta.qn, meta]),
)

export function qualityMeta(qn: number): QualityMeta | undefined {
  return QUALITY_BY_QN.get(qn)
}

/** 档位所需身份；矩阵未收录的值按阈值保守推断 */
export function accessLevelOf(qn: number): AccessLevel {
  const meta = QUALITY_BY_QN.get(qn)
  if (meta) return meta.access
  if (qn >= QN.Q1080P_PLUS) return 'vip'
  if (qn >= QN.Q720P60) return 'login'
  return 'anonymous'
}

export function canAccess(qn: number, session: AccountSession): boolean {
  return accessAllows(accessLevelOf(qn), session)
}

/** 某个身份等级在给定登录态下是否有权访问 */
function accessAllows(level: AccessLevel, session: AccountSession): boolean {
  if (level === 'anonymous') return true
  if (level === 'login') return session.loggedIn
  return session.loggedIn && session.vip
}

/** 单个档位对当前身份的可用性状态 */
export const qualityStateSchema = z.enum([
  'available',
  'need-login',
  'need-vip',
  'not-delivered',
])

export type QualityState = z.infer<typeof qualityStateSchema>

/**
 * 单个档位对当前身份的可用性。
 * 字段顺序即前后端约定的形状，勿随意调整。
 */
export const qualityAvailabilitySchema = z.object({
  qn: z.number().int(),
  label: z.string(),
  access: accessLevelSchema,
  state: qualityStateSchema,
  available: z.boolean(),
  reason: z.string(),
})

export type QualityAvailability = z.infer<typeof qualityAvailabilitySchema>

/**
 * 不可用状态 → 中文原因文案。
 * video（availabilityFor）与 audio（audioAvailabilityFor）两条路径共用同一份文案，
 * 保证同一状态在 UI 上说同样的话。
 */
const REASON: Readonly<Record<QualityState, string>> = {
  available: '',
  'need-login': '登录后可解锁',
  'need-vip': '需要大会员',
  'not-delivered': '服务端未提供该档位',
}

/** 由「是否实际交付 + 所需身份」推导可用性状态 */
function stateOf(delivered: boolean, access: AccessLevel, session: AccountSession): QualityState {
  if (delivered) return 'available'
  if (accessAllows(access, session)) return 'not-delivered'
  return access === 'vip' ? 'need-vip' : 'need-login'
}

function stateFor(qn: number, delivered: ReadonlySet<number>, session: AccountSession): QualityState {
  return stateOf(delivered.has(qn), accessLevelOf(qn), session)
}

/**
 * 计算每个档位的可用性。
 *
 * **实测铁律**：`accept_quality` 是"稿件声明支持的档位"，不等于当前身份能拿到的档位。
 * 匿名实测 BV1GJ411x7h7：accept_quality=[112,80,64,32,16]，但 dash.video[].id 只有 [16,32]。
 * 因此可用性必须以**实际交付**（dash.video[].id）为准，否则 UI 会显示可下 1080P 而实际失败。
 *
 * @param acceptQuality 服务端声明的档位（仅用于生成候选，含"登录后可能解锁"的项）
 * @param deliveredIds  实际交付的 dash.video[].id —— 唯一可用性依据
 */
export function availabilityFor(
  acceptQuality: readonly number[],
  deliveredIds: readonly number[],
  session: AccountSession,
): QualityAvailability[] {
  const delivered = new Set(deliveredIds)
  const candidates = acceptQuality.length > 0 ? acceptQuality : deliveredIds
  const seen = new Set<number>()
  const list: QualityAvailability[] = []
  for (const qn of candidates) {
    if (seen.has(qn)) continue
    seen.add(qn)
    const state = stateFor(qn, delivered, session)
    list.push({
      qn,
      label: qualityMeta(qn)?.label ?? `${qn}`,
      access: accessLevelOf(qn),
      state,
      available: state === 'available',
      reason: REASON[state],
    })
  }
  return list.sort((a, b) => b.qn - a.qn)
}

/** 当前身份下可下载的档位（按实际交付判定） */
export function accessibleQualities(
  acceptQuality: readonly number[],
  deliveredIds: readonly number[],
  session: AccountSession = { loggedIn: false, vip: false },
): number[] {
  return availabilityFor(acceptQuality, deliveredIds, session)
    .filter((item) => item.available)
    .map((item) => item.qn)
}

/** 音频流音质代码 */
export const AUDIO_QN = {
  K64: 30216,
  K132: 30232,
  K192: 30280,
  DOLBY_ATMOS: 30250,
  HIRES_FLAC: 30251,
} as const

export type AudioQualityCode = (typeof AUDIO_QN)[keyof typeof AUDIO_QN]

export interface AudioQualityMeta {
  id: AudioQualityCode
  label: string
  access: AccessLevel
  /** 该音流在 playurl 响应里的位置 */
  source: 'dash.audio' | 'dash.dolby.audio' | 'dash.flac.audio'
}

export const AUDIO_QUALITY_META: readonly AudioQualityMeta[] = [
  { id: AUDIO_QN.K64, label: '64K', access: 'anonymous', source: 'dash.audio' },
  { id: AUDIO_QN.K132, label: '132K', access: 'anonymous', source: 'dash.audio' },
  { id: AUDIO_QN.K192, label: '192K', access: 'anonymous', source: 'dash.audio' },
  { id: AUDIO_QN.DOLBY_ATMOS, label: '杜比全景声', access: 'vip', source: 'dash.dolby.audio' },
  { id: AUDIO_QN.HIRES_FLAC, label: 'Hi-Res 无损', access: 'vip', source: 'dash.flac.audio' },
] as const

/**
 * 单个音频档位对当前身份的可用性。
 * 字段顺序即前后端约定的形状，勿随意调整。
 */
export const audioAvailabilitySchema = z.object({
  id: z.number().int(),
  label: z.string(),
  access: accessLevelSchema,
  state: qualityStateSchema,
  available: z.boolean(),
  reason: z.string(),
})

export type AudioAvailability = z.infer<typeof audioAvailabilitySchema>

/**
 * 音频档位可用性；与视频档位同样的「以实际交付为准」铁律。
 *
 * 候选固定来自 {@link AUDIO_QUALITY_META}（共 5 项），可用性只看实际交付：
 * - 已交付（出现在 deliveredIds）→ available，reason 为空字符串；
 * - 未交付且当前身份无权访问 → need-login / need-vip（按 access 字段）；
 * - 未交付但当前身份有权（例如大会员）→ not-delivered（服务端确实没给，不是权限问题）。
 *
 * @param deliveredIds 实际交付的音频流 id，含 dash.audio / dash.dolby.audio / dash.flac.audio
 * @param session      当前账号登录态
 * @returns 按 id 降序排列的音频档位可用性
 */
export function audioAvailabilityFor(
  deliveredIds: readonly number[],
  session: AccountSession,
): AudioAvailability[] {
  const delivered = new Set(deliveredIds)
  return AUDIO_QUALITY_META.map((meta) => {
    const state = stateOf(delivered.has(meta.id), meta.access, session)
    return {
      id: meta.id,
      label: meta.label,
      access: meta.access,
      state,
      available: state === 'available',
      reason: REASON[state],
    }
  }).sort((a, b) => b.id - a.id)
}

/** fnval 位掩码；FNVAL_MAX = 4048，一次性要齐 dash/AV1/8K/杜比/4K/HDR */
export const FNVAL = {
  FLV: 0,
  MP4: 1,
  DASH: 16,
  HDR: 64,
  FOUR_K: 128,
  DOLBY_AUDIO: 256,
  DOLBY_VISION: 512,
  EIGHT_K: 1024,
  AV1: 2048,
} as const

export const FNVAL_MAX =
  FNVAL.DASH |
  FNVAL.HDR |
  FNVAL.FOUR_K |
  FNVAL.DOLBY_AUDIO |
  FNVAL.DOLBY_VISION |
  FNVAL.EIGHT_K |
  FNVAL.AV1

/** 与权限/风控相关的公共错误码 */
export const BILI_CODE = {
  SUCCESS: 0,
  NOT_LOGIN: -101,
  ACCOUNT_BANNED: -102,
  CSRF_FAILED: -111,
  NO_PERMISSION: -403,
  NOT_FOUND: -404,
  /** 请求被拦截（风控） */
  RISK_BLOCKED: -412,
  /** 请求过于频繁 */
  TOO_FREQUENT: -509,
  /** 风控校验失败，需要 v_voucher */
  RISK_VOUCHER: -352,
} as const

export type BiliCode = (typeof BILI_CODE)[keyof typeof BILI_CODE]

/** 是否属于「应退避重试」的风控类错误 */
export function isRiskControlCode(code: number): boolean {
  return (
    code === BILI_CODE.RISK_BLOCKED ||
    code === BILI_CODE.TOO_FREQUENT ||
    code === BILI_CODE.RISK_VOUCHER
  )
}

/** 是否属于「重试无用」（权限/账号类）的错误 */
export function isNonRetryableAuthCode(code: number): boolean {
  return (
    code === BILI_CODE.NOT_LOGIN ||
    code === BILI_CODE.ACCOUNT_BANNED ||
    code === BILI_CODE.CSRF_FAILED ||
    code === BILI_CODE.NO_PERMISSION
  )
}

/* ------------------------------- 错误码 → 语义 ------------------------------- */

/** 地区/身份限制；B站偶发返回，未收录进 BILI_CODE，这里保留原始码 */
const CODE_REGION_FORBIDDEN = -10403

/** 错误分类：调用方据此决定退避重试 / 引导登录 / 直接失败 */
export type BiliErrorKind = 'risk' | 'auth' | 'permission' | 'notFound' | 'fatal'

/**
 * B站业务码 → 错误分类；未知码归为 `fatal`。
 *
 * - `-412` / `-509` / `-352` → `'risk'`（风控，应退避后重试）
 * - `-101` / `-102` / `-111` → `'auth'`（账号/登录态问题，重试无用，应引导重新登录）
 * - `-403` / `-10403` → `'permission'`（权限/地区限制，重试无用）
 * - `-404` → `'notFound'`
 * - 其它（含 `0`）→ `'fatal'`
 *
 * 注意：`0` 表示成功，调用方应先判断 `code !== 0` 再调用本函数（对 `0` 本函数仍返回 `'fatal'`）。
 */
export function classifyBiliCode(code: number): BiliErrorKind {
  switch (code) {
    case BILI_CODE.RISK_BLOCKED:
    case BILI_CODE.TOO_FREQUENT:
    case BILI_CODE.RISK_VOUCHER:
      return 'risk'
    case BILI_CODE.NOT_LOGIN:
    case BILI_CODE.ACCOUNT_BANNED:
    case BILI_CODE.CSRF_FAILED:
      return 'auth'
    case BILI_CODE.NO_PERMISSION:
    case CODE_REGION_FORBIDDEN:
      return 'permission'
    case BILI_CODE.NOT_FOUND:
      return 'notFound'
    default:
      return 'fatal'
  }
}

/**
 * B站业务码 → 中文提示。
 *
 * NFR-07：错误码到用户文案的映射集中在 shared，服务端必须复用这里的文案，
 * 不得在各处自行硬编码。文案要具体、可操作。
 */
export const BILI_MESSAGE: Readonly<Record<number, string>> = {
  0: '成功',
  [BILI_CODE.NOT_LOGIN]: '账号未登录',
  [BILI_CODE.ACCOUNT_BANNED]: '账号已被封停',
  [BILI_CODE.CSRF_FAILED]: 'CSRF 校验失败',
  [BILI_CODE.NO_PERMISSION]: '无访问权限（可能需要大会员）',
  [BILI_CODE.NOT_FOUND]: '稿件不存在或已删除',
  [BILI_CODE.RISK_BLOCKED]: '请求被风控拦截，请稍后退避重试',
  [BILI_CODE.TOO_FREQUENT]: '请求过于频繁，请降低频率',
  [BILI_CODE.RISK_VOUCHER]: '风控校验失败（需要 v_voucher）',
  [CODE_REGION_FORBIDDEN]: '该内容在当前地区/身份下不可播放',
}

/**
 * 取业务码对应的中文提示。
 *
 * @param code     接口返回的业务码
 * @param fallback 未收录时的兜底文案；不传则用 `B站接口返回错误（code=<code>）`
 */
export function biliMessageOf(code: number, fallback?: string): string {
  return BILI_MESSAGE[code] ?? fallback ?? `B站接口返回错误（code=${code}）`
}

/* ---------------------------------- schemas --------------------------------- */

/** GET https://api.bilibili.com/x/frontend/finger/spi —— 设备指纹（免登必需） */
export const buvidSpiSchema = z.object({
  code: z.number(),
  message: z.string().optional(),
  data: z.object({
    b_3: z.string(),
    b_4: z.string(),
  }),
})
export type BuvidSpi = z.infer<typeof buvidSpiSchema>

/** GET https://api.bilibili.com/x/web-interface/nav —— 免登可访问；登录后带账号信息 */
export const navSchema = z.object({
  code: z.number(),
  message: z.string().optional(),
  data: z.object({
    isLogin: z.boolean(),
    mid: z.number().optional(),
    uname: z.string().optional(),
    face: z.string().optional(),
    vipStatus: z.number().optional(),
    vipType: z.number().optional(),
    wbi_img: z
      .object({
        img_url: z.string(),
        sub_url: z.string(),
      })
      .optional(),
  }),
})
export type Nav = z.infer<typeof navSchema>

/* --- 实测（M1-9）：B站对"不存在的字段"既可能省略也可能显式返回 null，
       两种都要收敛成 undefined，否则真实响应会过不了 schema --- */
const optionalString = z
  .string()
  .nullish()
  .transform((value) => value ?? undefined)
const optionalNumber = z
  .number()
  .nullish()
  .transform((value) => value ?? undefined)
const optionalStringList = z
  .array(z.string())
  .nullish()
  .transform((value) => value ?? undefined)

/** 真实响应里出现过 null 的顶层数组字段；统一收敛成数组 */
const numberList = z
  .array(z.number())
  .nullish()
  .transform((value) => value ?? [])
const stringList = z
  .array(z.string())
  .nullish()
  .transform((value) => value ?? [])

/** dash 音视频流；接口同时返回 baseUrl/base_url 两种命名，这里统一收敛 */
export const dashStreamSchema = z.object({
  id: z.number(),
  baseUrl: optionalString,
  base_url: optionalString,
  backupUrl: optionalStringList,
  backup_url: optionalStringList,
  bandwidth: optionalNumber,
  mimeType: optionalString,
  mime_type: optionalString,
  codecs: optionalString,
  width: optionalNumber,
  height: optionalNumber,
  /** 7 = AVC，12 = HEVC，13 = AV1 */
  codecid: optionalNumber,
})
export type DashStream = z.infer<typeof dashStreamSchema>

/**
 * GET https://api.bilibili.com/x/player/wbi/playurl
 *
 * 实测（M1-9，匿名 BV1GJ411x7h7）字段形态：
 * - `dash.video` / `dash.audio` 存在；`dash.dolby = { type: 0, audio: null }`；
 * - `dash.flac = null`；`data.high_format` / `data.view_info` 也是 null。
 * 因此所有"可选"字段都必须容忍 null —— 用 `.optional()` 会在真实请求上直接炸掉。
 */
export const playurlSchema = z.object({
  code: z.number(),
  message: z.string().optional(),
  data: z
    .object({
      quality: optionalNumber,
      accept_quality: numberList,
      accept_description: stringList,
      dash: z
        .object({
          duration: optionalNumber,
          video: z
            .array(dashStreamSchema)
            .nullish()
            .transform((value) => value ?? []),
          audio: z
            .array(dashStreamSchema)
            .nullish()
            .transform((value) => value ?? []),
          dolby: z
            .object({ audio: z.array(dashStreamSchema).nullish().transform((value) => value ?? []) })
            .nullish()
            .transform((value) => value ?? undefined),
          flac: z
            .object({ audio: dashStreamSchema.nullish().transform((value) => value ?? undefined) })
            .nullish()
            .transform((value) => value ?? undefined),
        })
        .optional(),
    })
    .optional(),
})
export type Playurl = z.infer<typeof playurlSchema>

/** 取流地址：优先 base_url，其次 baseUrl，最后退回备用地址 */
export function streamUrl(stream: DashStream): string | undefined {
  return (
    stream.base_url ?? stream.baseUrl ?? stream.backup_url?.[0] ?? stream.backupUrl?.[0] ?? undefined
  )
}

/** 按编码优先级挑一条视频流 */
export function pickStream(
  streams: readonly DashStream[],
  codecPriority: readonly number[],
): DashStream | undefined {
  for (const codecid of codecPriority) {
    const hit = streams.find((stream) => stream.codecid === codecid)
    if (hit) return hit
  }
  return streams[0]
}

/** 按音质优先级挑一条音频流 */
export function pickAudioStream(
  streams: readonly DashStream[],
  qualityPriority: readonly number[],
): DashStream | undefined {
  for (const id of qualityPriority) {
    const hit = streams.find((stream) => stream.id === id)
    if (hit) return hit
  }
  return streams[0]
}
