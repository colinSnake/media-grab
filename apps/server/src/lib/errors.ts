import {
  BILI_CODE,
  biliMessageOf,
  classifyBiliCode,
  type BiliErrorKind,
} from '@mediagrab/shared'

/**
 * 统一错误分类。
 * 分类先于重试：只有 network / risk 才值得重试，账号与权限类重试没有意义
 * （见 docs/TECH-DESIGN.md ADR-6）。
 *
 * B站业务码 → 分类 / 中文文案的映射集中在 `packages/shared`（NFR-07），
 * 本模块只负责把它翻译成 HTTP 语义与统一错误信封。
 */
export type ErrorKind =
  | 'network'
  | 'auth'
  | 'permission'
  | 'risk'
  | 'notFound'
  | 'invalid'
  | 'fatal'

export interface ApiErrorBody {
  error: {
    code: string
    message: string
    kind: ErrorKind
    retryable: boolean
    biliCode?: number
  }
}

/** 分类 → 对外错误码 */
const CODE_BY_KIND: Readonly<Record<BiliErrorKind, string>> = {
  risk: 'RISK_BLOCKED',
  auth: 'BILI_AUTH',
  permission: 'BILI_PERMISSION',
  notFound: 'BILI_NOT_FOUND',
  fatal: 'BILI_ERROR',
}

/** 分类 → HTTP 状态码 */
const STATUS_BY_KIND: Readonly<Record<BiliErrorKind, number>> = {
  risk: 429,
  auth: 403,
  permission: 403,
  notFound: 404,
  fatal: 502,
}

export class ApiError extends Error {
  readonly code: string
  readonly kind: ErrorKind
  readonly httpStatus: number
  readonly biliCode: number | undefined

  constructor(
    code: string,
    message: string,
    kind: ErrorKind,
    httpStatus = 400,
    biliCode?: number,
  ) {
    super(message)
    this.name = 'ApiError'
    this.code = code
    this.kind = kind
    this.httpStatus = httpStatus
    this.biliCode = biliCode
  }

  get retryable(): boolean {
    return this.kind === 'network' || this.kind === 'risk'
  }

  toBody(): ApiErrorBody {
    const error: ApiErrorBody['error'] = {
      code: this.code,
      message: this.message,
      kind: this.kind,
      retryable: this.retryable,
    }
    if (this.biliCode !== undefined) error.biliCode = this.biliCode
    return { error }
  }
}

/**
 * 把 B站业务错误码映射为统一错误。
 *
 * 注意成功码 `0` 不在这里处理：调用方必须先判 `code === 0`，
 * 否则会出现"成功却抛错"这种自相矛盾的路径。
 */
export function apiErrorFromBiliCode(biliCode: number, message?: string): ApiError {
  const kind = classifyBiliCode(biliCode)
  return new ApiError(
    CODE_BY_KIND[kind],
    message ?? biliMessageOf(biliCode),
    kind,
    STATUS_BY_KIND[kind],
    biliCode,
  )
}

/**
 * HTTP 状态码 → 统一错误（响应体不是 B站 JSON 信封时使用）。
 *
 * 412 / 429 属于风控（RISK §6）；403 归为权限类（API 域下的 403 是鉴权拒绝，
 * 取流的 403 是盗链/过期，那条路径由下载引擎按 `network` 处理）。
 */
export function apiErrorFromHttpStatus(status: number, message?: string): ApiError {
  if (status === 412 || status === 429) {
    return new ApiError(
      'RISK_BLOCKED',
      message ?? biliMessageOf(BILI_CODE.RISK_BLOCKED),
      'risk',
      429,
      status === 412 ? BILI_CODE.RISK_BLOCKED : BILI_CODE.TOO_FREQUENT,
    )
  }
  if (status === 403) {
    return new ApiError('BILI_PERMISSION', message ?? '无访问权限（可能需要大会员）', 'permission', 403)
  }
  if (status === 404) {
    return new ApiError('BILI_NOT_FOUND', message ?? '接口或稿件不存在', 'notFound', 404)
  }
  if (status >= 500) {
    return new ApiError('UPSTREAM_ERROR', message ?? `B站服务异常（HTTP ${status}）`, 'network', 502)
  }
  return new ApiError('UPSTREAM_ERROR', message ?? `请求失败（HTTP ${status}）`, 'network', 502)
}

/** 任何异常 → 统一错误信封（供 Fastify 错误处理器使用） */
export function toApiErrorBody(err: unknown): ApiErrorBody {
  if (err instanceof ApiError) return err.toBody()

  const status = httpStatusOf(err)
  if (status >= 400 && status < 500) {
    // Fastify 自身的 4xx（例如 JSON 体解析失败）属于客户端输入问题，
    // 不应被标成 INTERNAL / fatal。
    return {
      error: {
        code: readStringProp(err, 'code') ?? 'BAD_REQUEST',
        message: err instanceof Error ? err.message : '请求不合法',
        kind: 'invalid',
        retryable: false,
      },
    }
  }

  return {
    error: {
      code: 'INTERNAL',
      message: err instanceof Error ? err.message : '未知错误',
      kind: 'fatal',
      retryable: false,
    },
  }
}

function readStringProp(value: unknown, key: string): string | undefined {
  if (typeof value === 'object' && value !== null && key in value) {
    const raw = (value as Record<string, unknown>)[key]
    if (typeof raw === 'string') return raw
  }
  return undefined
}

/**
 * 从任意异常里取 HTTP 状态码。
 * Fastify 5 的 setErrorHandler 把错误参数标为 unknown，因此统一在这里收敛判断。
 */
export function httpStatusOf(err: unknown): number {
  if (err instanceof ApiError) return err.httpStatus
  if (typeof err === 'object' && err !== null && 'statusCode' in err) {
    const code = (err as { statusCode?: unknown }).statusCode
    if (typeof code === 'number' && Number.isInteger(code) && code >= 100 && code <= 599) {
      return code
    }
  }
  return 500
}
