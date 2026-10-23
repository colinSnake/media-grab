/** The core handles account cookies and local files; it must never bind to a LAN interface. */
export function isLoopbackHost(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1'
}

const DESKTOP_ORIGINS = new Set([
  'tauri://localhost',
  'http://tauri.localhost',
  'https://tauri.localhost',
  'http://localhost:9067',
  'http://127.0.0.1:9067',
])

/** Only the desktop WebView, Vite dev UI and the core's own web page may use browser APIs. */
export function isAllowedOrigin(origin: string, host: string | undefined): boolean {
  if (DESKTOP_ORIGINS.has(origin)) return true
  if (!host) return false
  try {
    const url = new URL(origin)
    return url.protocol === 'http:' && isLoopbackHost(url.hostname.replace(/^\[|\]$/g, '')) && url.host === host
  } catch {
    return false
  }
}

/** Reject DNS-rebinding requests even if a browser sends no Origin header. */
export function isAllowedHost(host: string | undefined): boolean {
  if (!host || !/^(?:127\.0\.0\.1|localhost|\[::1\])(?::\d{1,5})?$/.test(host)) return false
  try {
    const url = new URL(`http://${host}`)
    return isLoopbackHost(url.hostname.replace(/^\[|\]$/g, '')) && !url.username && !url.password && url.pathname === '/'
  } catch {
    return false
  }
}

export function corsOrigins(origin: string | undefined, callback: (error: Error | null, allowed: boolean) => void): void {
  // The hook checks the exact core-host origin before any handler, including WebSocket.
  // CORS itself only allows loopback origins so foreign sites cannot read responses.
  if (origin === undefined) return callback(null, false)
  if (DESKTOP_ORIGINS.has(origin)) return callback(null, true)
  try {
    const url = new URL(origin)
    callback(null, url.protocol === 'http:' && isLoopbackHost(url.hostname.replace(/^\[|\]$/g, '')))
  } catch {
    callback(null, false)
  }
}
