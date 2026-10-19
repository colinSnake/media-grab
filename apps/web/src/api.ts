import type {
  AppConfig,
  AccountListResponse,
  AccountSummary,
  AppConfigPatch,
  CreateTaskRequest,
  HealthResponse,
  MediaParseResult,
  ParseResult,
  TaskSnapshot,
} from '@mediagrab/shared'

/** M1 起 /api/health 的响应类型由 shared 提供，前后端共用同一份定义（NFR-07） */
export type { HealthResponse }

export function getAccounts(): Promise<AccountListResponse> {
  return request<AccountListResponse>('/api/accounts')
}

export function importBiliAccount(label: string, cookie: string): Promise<AccountSummary> {
  return request<AccountSummary>('/api/accounts/bilibili', { method: 'POST', body: JSON.stringify({ label, cookie }) })
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

function readErrorMessage(data: unknown): string | undefined {
  if (typeof data === 'object' && data !== null && 'error' in data) {
    const err = (data as { error?: { message?: unknown } }).error
    if (typeof err?.message === 'string') return err.message
  }
  return undefined
}

function apiBase(): string {
  const configured = (globalThis as { __MEDIAGRAB_CORE_URL__?: unknown }).__MEDIAGRAB_CORE_URL__
  if (typeof configured === 'string' && configured.trim() !== '') return configured.replace(/\/$/, '')
  if (typeof window !== 'undefined' && !['http:', 'https:'].includes(window.location.protocol)) {
    return 'http://127.0.0.1:8787'
  }
  return ''
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  let response: Response
  try {
    response = await fetch(`${apiBase()}${url}`, {
      headers: { 'Content-Type': 'application/json' },
      ...init,
    })
  } catch {
    throw new Error('本地核心未连接，请先启动 MediaGrab 核心服务（默认端口 8787）。')
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

export function getHealth(): Promise<HealthResponse> {
  return request<HealthResponse>('/api/health')
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

export function createTask(payload: CreateTaskRequest): Promise<TaskSnapshot> {
  return request<TaskSnapshot>('/api/tasks', { method: 'POST', body: JSON.stringify(payload) })
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
