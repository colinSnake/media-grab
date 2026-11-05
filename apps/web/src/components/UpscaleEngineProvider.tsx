import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import type { UpscaleCapability } from '@mediagrab/shared'
import { request } from '../api'
import { isDesktop } from '../native'
import { UpscaleEngineStatus } from './UpscaleEngineStatus'

type EngineState = { capability: UpscaleCapability | null; error: string; retry: () => void }
const EngineContext = createContext<EngineState | null>(null)

export function UpscaleEngineProvider({ connection = 'ready', children }: {
  connection?: 'connecting' | 'ready' | 'disconnected'
  children: ReactNode
}) {
  const [capability, setCapability] = useState<UpscaleCapability | null>(null)
  const [error, setError] = useState('')
  const [revision, setRevision] = useState(0)
  const generation = useRef(0)
  const retry = useCallback(() => { generation.current++; setCapability(null); setError(''); setRevision((v) => v + 1) }, [])
  useEffect(() => {
    const current = ++generation.current
    setCapability(null); setError('')
    if (!isDesktop()) { setError('本地超分仅供已验证的 macOS Apple Silicon 桌面会话使用。'); return }
    if (connection !== 'ready') return
    void request<UpscaleCapability>('/api/upscale/capability').then((value) => {
      if (current === generation.current) setCapability(value)
    }).catch((cause: unknown) => {
      if (current === generation.current) setError(cause instanceof Error ? cause.message : String(cause))
    })
    return () => { generation.current++ }
  }, [connection, revision])
  // Never show a previously healthy engine while the core is disconnected.
  const value: EngineState = {
    capability: connection === 'ready' ? capability : null,
    error: connection === 'disconnected' ? '本地服务未连接，连接恢复后将自动检查超分引擎。' : connection === 'connecting' ? '' : error,
    retry,
  }
  return <EngineContext.Provider value={value}>{children}</EngineContext.Provider>
}

export function useUpscaleEngine() {
  const engine = useContext(EngineContext)
  if (!engine) throw new Error('Upscale engine must be used inside UpscaleEngineProvider')
  return engine
}

export function GlobalUpscaleEngineStatus() {
  const { capability, error, retry } = useUpscaleEngine()
  return <UpscaleEngineStatus capability={capability} error={error} onRetry={retry} />
}
