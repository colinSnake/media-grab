import { invoke } from '@tauri-apps/api/core'
import type {
  AppConfig,
  AccountListResponse,
  AccountSummary,
  AppConfigPatch,
  CreateTaskRequest,
  CreateTaskResponse,
  HealthResponse,
  MediaParseResult,
  ParseResult,
  TaskSnapshot,
  CookieAccountPlatform,
  CookieStatus,
} from '@mediagrab/shared'

/** M1 起 /api/health 的响应类型由 shared 提供，前后端共用同一份定义（NFR-07） */
export type { HealthResponse }

export function getAccounts(): Promise<AccountListResponse> {
  return request<AccountListResponse>('/api/accounts')
}

export function importBiliAccount(cookie: string): Promise<AccountSummary> {
  return request<AccountSummary>('/api/accounts/bilibili', { method: 'POST', body: JSON.stringify({ cookie }) })
}

export function activateAccount(id: string): Promise<AccountSummary> {
  return request<AccountSummary>(`/api/accounts/${encodeURIComponent(id)}/activate`, { method: 'POST' })
}

export function verifyAccount(id: string): Promise<AccountSummary> {
  return request<AccountSummary>(`/api/accounts/${encodeURIComponent(id)}/verify`, { method: 'POST' })
}

export function removeAccount(id: string): Promise<void> {
  return request<void>(`/api/accounts/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

export function getCookieStatus(platform: CookieAccountPlatform): Promise<CookieStatus> {
  return request<CookieStatus>(`/api/accounts/${platform}/cookie`)
}

export function saveCookie(platform: CookieAccountPlatform, cookie: string): Promise<CookieStatus> {
  return request<CookieStatus>(`/api/accounts/${platform}/cookie`, { method: 'POST', body: JSON.stringify({ cookie }) })
}

export function clearCookie(platform: CookieAccountPlatform): Promise<CookieStatus> {
  return request<CookieStatus>(`/api/accounts/${platform}/cookie`, { method: 'DELETE' })
}

function readErrorMessage(data: unknown): string | undefined {
  if (typeof data === 'object' && data !== null && 'error' in data) {
    const err = (data as { error?: { message?: unknown } }).error
    if (typeof err?.message === 'string') return err.message
  }
  return undefined
}

export function apiBase(): string {
  const configured = (globalThis as { __MEDIAGRAB_CORE_URL__?: unknown }).__MEDIAGRAB_CORE_URL__
  if (typeof configured === 'string' && configured.trim() !== '') return configured.replace(/\/$/, '')
  // Tauri dev serves the WebView from Vite. Use its same-origin proxy instead
  // of making a cross-origin request to the local core from the dev window.
  if (typeof window !== 'undefined' && ['localhost', '127.0.0.1'].includes(window.location.hostname) && window.location.port === '9067') {
    return ''
  }
  if (typeof window !== 'undefined' && ('__TAURI_INTERNALS__' in window || !['http:', 'https:'].includes(window.location.protocol))) {
    return 'http://127.0.0.1:9070'
  }
  return ''
}

let coreTokenPromise: Promise<string> | undefined
let verifiedCoreToken = ''

export async function getCoreToken(): Promise<string> {
  if (apiBase() === '' || typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) return ''
  coreTokenPromise ??= invoke<string>('get_core_access').then((token) => {
    verifiedCoreToken = token
    return token
  }).catch((error: unknown) => {
    coreTokenPromise = undefined
    throw new Error(typeof error === 'string' ? error : '无法验证桌面核心身份')
  })
  return coreTokenPromise
}

export function apiUrl(path: string): string {
  const source = `${apiBase()}${path}`
  if (verifiedCoreToken && (path.startsWith('/api/cover?') || path.startsWith('/api/media/stream?'))) {
    return `${source}&media_token=${verifiedCoreToken}`
  }
  return source
}

export async function getTaskEventConnection(): Promise<{ url: string; protocols?: string[] }> {
  const token = await getCoreToken()
  const url = new URL(`${apiBase()}/api/ws`, window.location.href)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  return { url: url.toString(), protocols: token ? [`mg-${token}`] : undefined }
}

export async function fetchWithCoreAuth(path: string): Promise<Response> {
  const token = await getCoreToken()
  const headers = new Headers()
  if (token) headers.set('X-Mediagrab-Token', token)
  return fetch(apiUrl(path), { headers })
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const token = await getCoreToken()
  let response: Response
  try {
    const headers = new Headers(init?.headers)
    if (token) headers.set('X-Mediagrab-Token', token)
    if (init?.body === undefined) headers.delete('Content-Type')
    else if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/json')
    response = await fetch(apiUrl(url), { ...init, headers })
  } catch {
    throw new Error('暂时连不上下载服务，请稍后重试。')
  }
  const text = await response.text()

  let data: unknown
  if (text !== '') {
    try {
      data = JSON.parse(text)
    } catch {
      data = undefined
    }
  }

  if (!response.ok) {
    throw new Error(readErrorMessage(data) ?? `请求失败（HTTP ${response.status}）`)
  }
  return data as T
}

export function getHealth(signal?: AbortSignal): Promise<HealthResponse> {
  return request<HealthResponse>('/api/health', { signal })
}

export function getConfig(): Promise<AppConfig> {
  return request<AppConfig>('/api/config')
}

export function patchConfig(patch: AppConfigPatch): Promise<AppConfig> {
  return request<AppConfig>('/api/config', { method: 'PATCH', body: JSON.stringify(patch) })
}

export function parseMedia(input: string, page?: number): Promise<ParseResult> {
  return request<ParseResult>('/api/parse', {
    method: 'POST',
    body: JSON.stringify({ input, page }),
  })
}

export function parseUniversalMedia(input: string): Promise<MediaParseResult> {
  return request<MediaParseResult>('/api/media/parse', {
    method: 'POST',
    body: JSON.stringify({ input }),
  })
}

export function getTasks(): Promise<TaskSnapshot[]> {
  return request<TaskSnapshot[]>('/api/tasks')
}

export interface ExtractorStatus {
  available: boolean
  path: string
  version: string
  error: string
}

export function getExtractorStatus(): Promise<ExtractorStatus> {
  return request<ExtractorStatus>('/api/extractor/check')
}

export function createTask(payload: CreateTaskRequest): Promise<CreateTaskResponse> {
  return request<CreateTaskResponse>('/api/tasks', { method: 'POST', body: JSON.stringify(payload) })
}

export function cancelTask(id: string): Promise<TaskSnapshot> {
  return request<TaskSnapshot>(`/api/tasks/${encodeURIComponent(id)}/cancel`, { method: 'POST' })
}

export function retryTask(id: string): Promise<TaskSnapshot> {
  return request<TaskSnapshot>(`/api/tasks/${encodeURIComponent(id)}/retry`, { method: 'POST' })
}

export function removeTask(id: string): Promise<void> {
  return request<void>(`/api/tasks/${encodeURIComponent(id)}`, { method: 'DELETE' })
}
