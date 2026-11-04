import { Cpu, LoaderCircle, RotateCw } from 'lucide-react'
import type { UpscaleCapability } from '@mediagrab/shared'
import { ServiceStatusPopover } from './ServiceStatusPopover'

export function UpscaleEngineStatus({ capability, error, onRetry }: {
  capability: UpscaleCapability | null
  error?: string
  onRetry: () => void
}) {
  const state = capability?.available ? 'ready' : capability || error ? 'unavailable' : 'checking'
  const label = state === 'ready' ? '引擎就绪' : state === 'checking' ? '检查中' : '引擎不可用'
  const reason = error || capability?.reason || '本地超分引擎不可用，请检查依赖后重试。'
  return <ServiceStatusPopover title="超分引擎" state={state} label={label} icon={<Cpu aria-hidden="true" />} className="upscale-engine" action={
    <button type="button" className="service-status-refresh" aria-label="重新检查超分引擎" data-tooltip="重新检查" aria-busy={state === 'checking'} disabled={state === 'checking'} onClick={onRetry}>
      {state === 'checking' ? <LoaderCircle className="spin" aria-hidden="true" /> : <RotateCw aria-hidden="true" />}
    </button>
  }>
    <p className="service-status-summary">Real-ESRGAN AnimeVideo<span className="service-status-scale">2×</span></p>
    {state === 'unavailable' && <p className="service-status-reason" role="alert">{reason}</p>}
  </ServiceStatusPopover>
}
