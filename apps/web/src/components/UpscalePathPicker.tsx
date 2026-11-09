import { useEffect, useState } from 'react'
import { Check, Copy, FolderOpen, AlertTriangle } from 'lucide-react'

export function UpscalePathPicker({ kind, mediaKind = 'video', path, disabled, onChoose }: {
  kind: 'input' | 'directory'
  mediaKind?: 'video' | 'image'
  path?: string
  disabled: boolean
  onChoose: () => void
}) {
  const label = kind === 'input' ? mediaKind === 'image' ? '输入图片' : '输入视频' : '输出目录'
  const [feedback, setFeedback] = useState<{ path: string; status: 'copied' | 'failed' } | null>(null)
  const status = feedback?.path === path ? feedback?.status : undefined
  useEffect(() => {
    if (!feedback) return
    const timer = window.setTimeout(() => setFeedback(null), 2000)
    return () => window.clearTimeout(timer)
  }, [feedback])
  const copy = async () => {
    if (!path) return
    try {
      let copied = false
      if (navigator.clipboard?.writeText) {
        try { await navigator.clipboard.writeText(path); copied = true } catch { /* WebView may require the fallback below. */ }
      }
      if (!copied) {
        const focused = document.activeElement
        const input = document.createElement('textarea')
        input.value = path
        input.readOnly = true
        input.style.position = 'fixed'
        input.style.opacity = '0'
        document.body.append(input)
        try { input.select(); copied = document.execCommand('copy') }
        finally { input.remove(); if (focused instanceof HTMLElement) focused.focus({ preventScroll: true }) }
      }
      if (!copied) throw new Error('复制失败')
      setFeedback({ path, status: 'copied' })
    } catch { setFeedback({ path, status: 'failed' }) }
  }
  const copyLabel = status === 'copied' ? `${label}地址已复制` : status === 'failed' ? '复制失败，请重试' : `复制${label}地址`
  return <div className="upscale-field">
    <span className="upscale-field-label" id={`upscale-${kind}-label`}>{label}</span>
    <div className="upscale-picker" role="group" aria-labelledby={`upscale-${kind}-label`}>
      <button className="upscale-button secondary" type="button" disabled={disabled} onClick={onChoose}><FolderOpen />{kind === 'input' ? mediaKind === 'image' ? '选择图片' : '选择 MP4' : '选择目录'}</button>
      <span className={path ? 'upscale-path-selected' : undefined} aria-live="polite">{path ? '已选择' : kind === 'input' ? mediaKind === 'image' ? '尚未选择图片' : '尚未选择视频' : '尚未选择目录'}</span>
      <button className={`icon-button upscale-copy-button ${status ?? ''}`} type="button" disabled={!path} data-tooltip={copyLabel} aria-label={copyLabel} onClick={() => void copy()}>
        {status === 'copied' ? <Check /> : status === 'failed' ? <AlertTriangle /> : <Copy />}
      </button>
      <span className="upscale-copy-feedback" role="status">{status ? copyLabel : ''}</span>
    </div>
  </div>
}
