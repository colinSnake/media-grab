/**
 * 结构化日志与脱敏（NFR-03 / NFR-07）。
 *
 * 红线：**日志里不允许出现凭据明文**（SESSDATA 等价于密码）。
 * 所有涉及 Cookie / 签名 / 票据的日志都必须先过本模块的函数。
 */

/** 与 pino（Fastify 默认 logger）兼容的最小日志接口 */
export interface Logger {
  debug: (obj: unknown, msg?: string) => void
  info: (obj: unknown, msg?: string) => void
  warn: (obj: unknown, msg?: string) => void
  error: (obj: unknown, msg?: string) => void
}

/** 测试用：吞掉所有日志 */
export const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
}

/** 需要整体遮罩的 Cookie 名（凭据类） */
const SECRET_COOKIE_KEYS = new Set([
  'sessdata',
  'bili_jct',
  'dedeuserid',
  'dedeuserid__ckmd5',
  'sid',
  'bili_ticket',
  'access_token',
  'ac_time_value',
])

/** 设备指纹类：保留前 4 位便于排障，其余遮罩（RISK §4） */
const FINGERPRINT_COOKIE_KEYS = new Set(['buvid3', 'buvid4', 'b_nut', 'buvid_fp'])

/** URL query 里需要遮罩的参数名 */
const SECRET_QUERY_KEYS = new Set([
  'csrf',
  'hexsign',
  'sign',
  'w_rid',
  'sessdata',
  'access_token',
  'access_key',
  'bili_jct',
  'ticket',
])

/** 前缀保留 + 星号遮罩 */
export function maskSecret(value: string, keep = 4): string {
  if (value === '') return ''
  if (value.length <= keep) return '*'.repeat(value.length)
  return `${value.slice(0, keep)}${'*'.repeat(Math.min(8, value.length - keep))}`
}

/**
 * Cookie 脱敏：保留键名与结构（排障要靠它），只遮罩值。
 * 凭据类整体遮罩；指纹类保留前 4 位。
 */
export function redactCookie(cookie: string | null | undefined): string {
  if (!cookie) return ''
  return cookie
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part !== '')
    .map((part) => {
      const eq = part.indexOf('=')
      if (eq < 0) return part
      const name = part.slice(0, eq)
      const value = part.slice(eq + 1)
      const lower = name.trim().toLowerCase()
      if (SECRET_COOKIE_KEYS.has(lower)) return `${name}=${maskSecret(value, 0)}`
      if (FINGERPRINT_COOKIE_KEYS.has(lower)) return `${name}=${maskSecret(value, 4)}`
      return `${name}=${maskSecret(value, 0)}`
    })
    .join('; ')
}

/** 请求头脱敏：Cookie 走 redactCookie，其余原样（值可能是签名，交 redactUrl 处理） */
export function redactHeaders(headers: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue
    out[key] = key.toLowerCase() === 'cookie' ? redactCookie(value) : value
  }
  return out
}

/** URL 脱敏：遮罩 query 中的签名/票据参数，路径与其余参数保留 */
export function redactUrl(raw: string): string {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return raw.replace(/([?&](?:csrf|hexsign|sign|w_rid|ticket)=)[^&]*/gi, '$1***')
  }

  for (const key of [...url.searchParams.keys()]) {
    if (SECRET_QUERY_KEYS.has(key.toLowerCase())) url.searchParams.set(key, '***')
  }
  return url.toString()
}

/** 票据/签名值脱敏（保留前 6 位便于比对是否换新） */
export function redactTicket(ticket: string | null | undefined): string {
  if (!ticket) return ''
  return maskSecret(ticket, 6)
}
