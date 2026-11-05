import { ApiError } from '../lib/errors.js'

const NETSCAPE_HEADER = '# Netscape HTTP Cookie File'
const COOKIE_MAX_LENGTH = 64 * 1024

export type CookiePlatform = 'douyin' | 'xiaohongshu' | 'youtube'

function isAllowedDomain(platform: CookiePlatform, domain: string): boolean {
  const normalized = domain.trim().replace(/^\./, '').toLowerCase()
  if (platform === 'douyin') {
    return normalized === 'douyin.com' || normalized.endsWith('.douyin.com')
      || normalized === 'iesdouyin.com' || normalized.endsWith('.iesdouyin.com')
  }
  if (platform === 'youtube') {
    return ['youtube.com', 'google.com', 'googlevideo.com', 'youtube-nocookie.com', 'youtu.be', 'ytimg.com'].some((host) => normalized === host || normalized.endsWith(`.${host}`))
  }
  return normalized === 'xiaohongshu.com' || normalized.endsWith('.xiaohongshu.com')
    || normalized === 'xhslink.com' || normalized.endsWith('.xhslink.com')
}

function netscapeLine(domain: string, name: string, value: string): string {
  return `${domain}\tTRUE\t/\tFALSE\t0\t${name}\t${value}`
}

/**
 * Normalize a pasted Cookie header or Netscape export for yt-dlp.
 * Keep only domains belonging to the selected platform; raw input is not logged.
 */
export function normalizePlatformCookie(platform: CookiePlatform, raw: string): string {
  const input = raw.trim().replace(/^Cookie:\s*/i, '')
  const platformLabel = platform === 'douyin' ? '抖音' : platform === 'youtube' ? 'YouTube' : '小红书'
  const defaultDomain = platform === 'douyin' ? '.douyin.com' : platform === 'youtube' ? '.youtube.com' : '.xiaohongshu.com'
  if (input === '' || input.length > COOKIE_MAX_LENGTH) {
    throw new ApiError(`INVALID_${platform.toUpperCase()}_COOKIE`, `${platformLabel} Cookie 不能为空且不能超过 64KB`, 'invalid', 400)
  }

  if (input.split(/\r?\n/, 1)[0]?.startsWith(NETSCAPE_HEADER) === true) {
    const lines = input.split(/\r?\n/)
      .filter((line) => !line.trim().startsWith('#') || line.startsWith('#HttpOnly_'))
      .filter((line) => {
        const fields = line.split('\t')
        return fields.length >= 7 && isAllowedDomain(platform, (fields[0] ?? '').replace(/^#HttpOnly_/, '')) && (fields[5] ?? '').trim() !== ''
      })
    if (lines.length === 0) throw new ApiError(`INVALID_${platform.toUpperCase()}_COOKIE`, `Cookie 文件中没有找到${platformLabel}域名的有效 Cookie`, 'invalid', 400)
    return `${NETSCAPE_HEADER}\n${lines.join('\n')}\n`
  }

  const pairs = input.split(';')
    .map((part) => part.trim())
    .map((part) => {
      const separator = part.indexOf('=')
      return separator > 0 ? [part.slice(0, separator).trim(), part.slice(separator + 1).trim()] as const : null
    })
    .filter((pair): pair is readonly [string, string] => pair !== null && /^[A-Za-z0-9_\-]+$/.test(pair[0]) && pair[1] !== '' && !/[\u0000-\u001f\u007f]/.test(pair[1]))

  if (pairs.length === 0) throw new ApiError(`INVALID_${platform.toUpperCase()}_COOKIE`, `无法识别${platformLabel} Cookie，请粘贴 name=value 格式或 Netscape Cookie 文件`, 'invalid', 400)
  return `${NETSCAPE_HEADER}\n${pairs.map(([name, value]) => netscapeLine(defaultDomain, name, value)).join('\n')}\n`
}

export function normalizeDouyinCookie(raw: string): string {
  return normalizePlatformCookie('douyin', raw)
}

export function normalizeXiaohongshuCookie(raw: string): string {
  return normalizePlatformCookie('xiaohongshu', raw)
}

export function normalizeYouTubeCookie(raw: string): string {
  return normalizePlatformCookie('youtube', raw)
}

// Only a declared expiry can prove expiration. Cookie headers/session cookies
// have no deadline, and extractor errors can also mean rate limits or restrictions.
const AUTH_COOKIE_NAMES: Record<CookiePlatform, ReadonlySet<string>> = {
  douyin: new Set(['sessionid', 'sessionid_ss', 'sid_tt']),
  xiaohongshu: new Set(['web_session']),
  youtube: new Set(['LOGIN_INFO', 'SID', '__Secure-1PSID', '__Secure-3PSID', 'SAPISID', '__Secure-1PAPISID', '__Secure-3PAPISID']),
}

export function platformCookieExpired(platform: CookiePlatform, cookie: string, now = Date.now()): boolean {
  const entries = cookie.split(/\r?\n/)
    .filter((line) => line && (!line.startsWith('#') || line.startsWith('#HttpOnly_')))
    .map((line) => line.split('\t'))
    .filter((fields) => fields.length >= 7 && isAllowedDomain(platform, (fields[0] ?? '').replace(/^#HttpOnly_/, '')))
  const authentication = entries.filter((fields) => AUTH_COOKIE_NAMES[platform].has(fields[5] ?? ''))
  const relevant = authentication.length ? authentication : entries
  return relevant.length > 0 && relevant.every((fields) => {
    const expiry = Number(fields[4])
    return Number.isFinite(expiry) && expiry > 0 && expiry * 1_000 <= now
  })
}
