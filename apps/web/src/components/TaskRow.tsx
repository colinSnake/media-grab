import {
  ArrowDownToLine,
  CalendarClock,
  Check,
  CircleAlert,
  Clock3,
  Copy,
  FileAudio2,
  FileImage,
  FileVideo2,
  Gauge,
  HardDrive,
  Link2,
  LoaderCircle,
  MoreHorizontal,
  RotateCcw,
  Trash2,
  X,
} from 'lucide-react'
import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { platformLabel, qualityMeta, taskProgress, type TaskSnapshot } from '@mediagrab/shared'
import { fetchWithCoreAuth } from '../api'
import { PlatformLogo } from './PlatformLogo'

export type DownloadResult = { status: 'success' | 'fail'; error?: string }

export function isTerminalTask(task: TaskSnapshot): boolean {
  return task.status === 'success' || task.status === 'fail' || task.status === 'stopped'
}

function taskStatusLabel(status: TaskSnapshot['status']): string {
  const labels: Record<TaskSnapshot['status'], string> = {
    waiting: '等待中',
    downloading: '下载中',
    merging: '合并中',
    success: '下载成功',
    fail: '失败',
    stopped: '已停止',
  }
  return labels[status]
}

function taskFileUrl(id: string, kind?: 'video' | 'audio' | 'image'): string {
  return `/api/tasks/${encodeURIComponent(id)}/file${kind ? `?kind=${kind}` : ''}`
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB']
  let value = bytes / 1024
  for (const unit of units) {
    if (value < 1024 || unit === units[units.length - 1]) return `${value.toFixed(value >= 10 ? 0 : 1)} ${unit}`
    value /= 1024
  }
  return `${bytes} B`
}

function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '剩余时间未知'
  const rounded = Math.ceil(seconds)
  if (rounded < 60) return `约 ${rounded} 秒`
  const minutes = Math.floor(rounded / 60)
  const rest = rounded % 60
  return rest === 0 ? `约 ${minutes} 分钟` : `约 ${minutes} 分 ${rest} 秒`
}

function phaseLabel(task: TaskSnapshot): string {
  if (task.status === 'waiting') return '等待调度'
  if (task.status === 'merging') return '处理中'
  if (task.phase === 'video') return '下载视频'
  if (task.phase === 'audio') return '下载音频'
  if (task.phase === 'image') return '下载图片'
  if (task.phase === 'done' || task.status === 'success') return '已完成'
  return task.status === 'fail' ? '下载失败' : task.status === 'stopped' ? '已停止' : '准备中'
}

function detailsStatus(task: TaskSnapshot, downloadResult?: DownloadResult): string {
  if (downloadResult?.status === 'success') return '下载成功'
  if (downloadResult?.status === 'fail') return '保存失败'
  return taskStatusLabel(task.status)
}

export function TaskStatusIndicator({ status, error }: { status: TaskSnapshot['status']; error?: string }) {
  const label = error ? `${taskStatusLabel(status)}：${error}` : taskStatusLabel(status)
  const [tooltip, setTooltip] = useState<{ top: number; left: number; below: boolean } | null>(null)
  useEffect(() => {
    if (tooltip === null) return
    const dismiss = () => setTooltip(null)
    window.addEventListener('scroll', dismiss, true)
    window.addEventListener('resize', dismiss)
    return () => { window.removeEventListener('scroll', dismiss, true); window.removeEventListener('resize', dismiss) }
  }, [tooltip])
  const showTooltip = (element: HTMLElement) => {
    const rect = element.getBoundingClientRect()
    const width = Math.min(260, window.innerWidth - 24)
    setTooltip({ top: rect.top < 100 ? rect.bottom + 8 : rect.top - 8, left: Math.max(12, Math.min(rect.right - width, window.innerWidth - width - 12)), below: rect.top < 100 })
  }
  return <span
    className={`task-indicator ${status} ${error ? 'task-error-indicator' : ''}`}
    aria-label={label}
    tabIndex={error ? 0 : undefined}
    {...(error ? {
      onMouseEnter: (event) => showTooltip(event.currentTarget),
      onMouseLeave: () => setTooltip(null),
      onFocus: (event) => showTooltip(event.currentTarget),
      onBlur: () => setTooltip(null),
    } : { title: label })}
  >
    {status === 'success' ? <Check /> : status === 'fail' || status === 'stopped' ? <X /> : status === 'waiting' ? <Clock3 /> : <LoaderCircle className="spin" />}
    {error && tooltip && createPortal(<span className="task-error-tooltip" role="tooltip" style={{ top: tooltip.top, left: tooltip.left, transform: tooltip.below ? undefined : 'translateY(-100%)' }}>{label}</span>, document.body)}
  </span>
}

export interface TaskRowProps {
  task: TaskSnapshot
  variant?: 'compact' | 'detail'
  downloadResult?: DownloadResult
  onCancel?: (id: string) => void | Promise<void>
  onRetry?: (id: string) => void | Promise<void>
  onRemove?: (id: string) => void | Promise<void>
  onDownloadResult?: (id: string, result: DownloadResult) => void
}

export function TaskRow({ task, variant = 'detail', downloadResult, onCancel, onRetry, onRemove, onDownloadResult }: TaskRowProps) {
  const [isSaving, setIsSaving] = useState(false)
  const [busyAction, setBusyAction] = useState<'cancel' | 'retry' | 'remove' | null>(null)
  const [showDetails, setShowDetails] = useState(false)
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle')

  useEffect(() => {
    if (!showDetails) return
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setShowDetails(false)
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [showDetails])

  async function runAction(action: 'cancel' | 'retry' | 'remove', handler: (id: string) => void | Promise<void>) {
    if (busyAction !== null) return
    setBusyAction(action)
    try {
      await handler(task.id)
    } finally {
      setBusyAction(null)
    }
  }

  async function downloadFile(kind?: 'video' | 'audio' | 'image', fileName?: string) {
    if (isSaving) return
    setIsSaving(true)
    try {
      const response = await fetchWithCoreAuth(taskFileUrl(task.id, kind))
      if (!response.ok) {
        const data = await response.json().catch(() => null) as { error?: { message?: string } } | null
        throw new Error(data?.error?.message ?? `HTTP ${response.status}`)
      }
      const blob = await response.blob()
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = fileName || task.fileName || `${task.title || task.id}.mp4`
      document.body.append(anchor)
      anchor.click()
      anchor.remove()
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000)
      onDownloadResult?.(task.id, { status: 'success' })
    } catch (error) {
      onDownloadResult?.(task.id, { status: 'fail', error: error instanceof Error ? error.message : '保存失败' })
    } finally {
      setIsSaving(false)
    }
  }

  async function copySourceLink() {
    const source = task.input || task.sourceId || task.bvid
    if (!source) return
    try {
      let copied = false
      if (navigator.clipboard?.writeText) {
        try {
          await navigator.clipboard.writeText(source)
          copied = true
        } catch {
          // Fall back when the WebView denies clipboard access.
        }
      }
      if (!copied) {
        const input = document.createElement('textarea')
        input.value = source
        input.setAttribute('readonly', '')
        input.style.position = 'fixed'
        input.style.opacity = '0'
        document.body.append(input)
        input.select()
        copied = document.execCommand('copy')
        input.remove()
      }
      if (!copied) throw new Error('复制失败')
      setCopyState('copied')
      window.setTimeout(() => setCopyState('idle'), 1800)
    } catch {
      setCopyState('failed')
      window.setTimeout(() => setCopyState('idle'), 2200)
    }
  }

  const terminal = isTerminalTask(task)
  const title = task.title || task.bvid || task.input
  const modeLabel = task.mode === 'image' ? '图片' : task.mode === 'audio'
    ? `音频 ${task.audioContainer ?? 'm4a'}`
    : task.mode === 'video' ? '仅视频' : '视频 + 音频'
  const resolutionLabel = task.qualityLabel ?? (task.qn === undefined ? '' : qualityMeta(task.qn)?.label ?? `${task.qn}P`)
  const progress = task.status === 'success' ? 1 : taskProgress(task)
  const remainingSeconds = task.speedBps > 0 && task.totalBytes > task.downloadedBytes
    ? (task.totalBytes - task.downloadedBytes) / task.speedBps
    : 0

  const savedAt = new Date(task.updatedAt)
  const savedAtLabel = Number.isFinite(savedAt.getTime()) ? savedAt.toLocaleString() : ''
  const indicatorStatus = task.status === 'success' ? downloadResult?.status : task.status
  const resourceLabel = [modeLabel, resolutionLabel].filter(Boolean).join(' · ')
  const statusLabel = task.status === 'success' && downloadResult === undefined ? '文件就绪' : detailsStatus(task, downloadResult)
  const statusClass = indicatorStatus ?? task.status
  const errorDetails = downloadResult?.status === 'fail' ? downloadResult.error : task.error
  const sourceLink = task.input || task.sourceId || task.bvid || '未提供'
  const outputFiles = task.files.length > 0 ? task.files : task.fileName ? [{ kind: task.mode === 'audio' ? 'audio' as const : task.mode === 'image' ? 'image' as const : 'video' as const, fileName: task.fileName, legacy: true }] : []
  return (
    <div className={variant === 'compact' ? 'task-row' : `task-view-row ${terminal ? 'terminal' : ''} ${isSaving ? 'saving' : ''}`}>
      <span className={`task-platform-icon ${task.platform}`} title={platformLabel[task.platform]}>
        {task.platform === 'unknown' ? <FileVideo2 /> : <PlatformLogo platform={task.platform} />}
      </span>
      <span className="task-title">
        <strong title={title}>{title}</strong>
        <span className="task-meta">
          <span className={`task-mode-tag ${task.mode}`} title={modeLabel}>{modeLabel}</span>
          {resolutionLabel !== '' && <span className="task-resolution-tag" title={resolutionLabel}>{resolutionLabel}</span>}
        </span>
      </span>
      {variant === 'detail' && (isSaving
        ? <span className="task-indicator saving" aria-label="正在保存文件" title="正在保存文件"><LoaderCircle className="spin" /></span>
        : indicatorStatus !== undefined
          ? <TaskStatusIndicator status={indicatorStatus} error={downloadResult?.status === 'fail' ? downloadResult.error : task.error} />
          : null)}
      {variant === 'detail' && task.status === 'success' && outputFiles.map((file) => (
        <button key={file.kind} className={`task-action ${isSaving ? 'saving' : ''}`} type="button" title={isSaving ? '正在保存文件…' : `保存${file.kind === 'audio' ? '音频' : file.kind === 'image' ? '图片' : '视频'}：${file.fileName}`} aria-label={`保存${file.kind === 'audio' ? '音频' : file.kind === 'image' ? '图片' : '视频'}`} onClick={() => void downloadFile('legacy' in file ? undefined : file.kind, file.fileName)} disabled={isSaving || busyAction !== null} aria-busy={isSaving}>
          {isSaving ? <LoaderCircle className="spin" /> : file.kind === 'audio' ? <FileAudio2 /> : file.kind === 'image' ? <FileImage /> : <ArrowDownToLine />}
        </button>
      ))}
      {!terminal && onCancel !== undefined && <button className="task-action" type="button" title={busyAction === 'cancel' ? '正在取消' : '取消任务'} aria-label={busyAction === 'cancel' ? '正在取消任务' : '取消任务'} onClick={() => void runAction('cancel', onCancel)} disabled={busyAction !== null} aria-busy={busyAction === 'cancel'}>{busyAction === 'cancel' ? <LoaderCircle className="spin" /> : <X />}</button>}
      {terminal && task.status !== 'success' && onRetry !== undefined && <button className="task-action" type="button" title={busyAction === 'retry' ? '正在加入队列' : '重试任务'} aria-label={busyAction === 'retry' ? '正在重试任务' : '重试任务'} onClick={() => void runAction('retry', onRetry)} disabled={busyAction !== null} aria-busy={busyAction === 'retry'}>{busyAction === 'retry' ? <LoaderCircle className="spin" /> : <RotateCcw />}</button>}
      {variant === 'detail' && <button className="task-action" type="button" title="更多任务信息" aria-label="更多任务信息" onClick={() => setShowDetails(true)}><MoreHorizontal /></button>}
      {terminal && onRemove !== undefined && <button className="task-action" type="button" title={busyAction === 'remove' ? '正在删除' : '删除历史任务'} aria-label={busyAction === 'remove' ? '正在删除历史任务' : '删除历史任务'} onClick={() => void runAction('remove', onRemove)} disabled={busyAction !== null} aria-busy={busyAction === 'remove'}>{busyAction === 'remove' ? <LoaderCircle className="spin" /> : <Trash2 />}</button>}
      {showDetails && createPortal(<div className="modal-backdrop task-details-backdrop" role="presentation" onClick={() => setShowDetails(false)}>
        <section className="task-details-modal" role="dialog" aria-modal="true" aria-labelledby={`task-details-title-${task.id}`} onClick={(event) => event.stopPropagation()}>
          <div className="modal-heading task-details-heading">
            <div className="task-details-heading-copy">
              <span className={`task-platform-icon ${task.platform}`} aria-hidden="true">{task.platform === 'unknown' ? <FileVideo2 /> : <PlatformLogo platform={task.platform} />}</span>
              <div><h2 id={`task-details-title-${task.id}`}>任务详情</h2></div>
            </div>
            <button className="icon-button" type="button" title="关闭详情" aria-label="关闭详情" onClick={() => setShowDetails(false)}><X /></button>
          </div>
          <div className="task-details-content">
            <section className="task-detail-section task-resource-section">
              <span className="task-detail-inline-icon large">{task.mode === 'image' ? <FileImage /> : <FileAudio2 />}</span>
              <div className="task-detail-copy">
                <strong className="task-detail-label">资源配置</strong>
                <div className="task-resource-values"><span className={`task-mode-tag ${task.mode}`}>{modeLabel}</span>{resolutionLabel !== '' && <span className="task-resolution-tag">{resolutionLabel}</span>}<span className={`task-platform-pill ${task.platform}`}>{platformLabel[task.platform]}</span><span className={`task-result-tag ${statusClass}`}>{statusLabel}</span></div>
              </div>
            </section>
            <section className="task-detail-section task-source-row">
              <span className="task-detail-inline-icon large"><Link2 /></span>
              <div className="task-source-content">
                <strong className="task-detail-label">来源链接</strong>
                <div className="task-source-value-row">
                  <span className="task-detail-source-value" title={sourceLink}>{sourceLink}</span>
                  <button className={`task-copy-button ${copyState}`} type="button" onClick={() => void copySourceLink()} disabled={sourceLink === '未提供'} title={copyState === 'copied' ? '已复制' : copyState === 'failed' ? '复制失败' : '复制来源链接'} aria-label={copyState === 'copied' ? '链接已复制' : copyState === 'failed' ? '复制链接失败' : '复制来源链接'}>
                    {copyState === 'copied' ? <Check /> : <Copy />}
                  </button>
                </div>
              </div>
            </section>
            <div className="task-detail-file-row">
              <section className="task-detail-file-item output"><span className="task-detail-inline-icon large">{task.mode === 'image' ? <FileImage /> : <FileVideo2 />}</span><div><strong className="task-detail-label">输出文件</strong>{outputFiles.length ? outputFiles.map((file) => <span className="task-detail-file-value" key={file.kind} title={file.fileName}>{file.fileName}</span>) : <span className="task-detail-file-value">尚未生成</span>}</div></section>
              <section className="task-detail-file-item"><span className="task-detail-inline-icon large"><HardDrive /></span><div><strong className="task-detail-label">文件大小</strong><span className="task-detail-file-value">{task.totalBytes > 0 ? formatBytes(task.totalBytes) : '未知'}</span></div></section>
              <section className="task-detail-file-item"><span className="task-detail-inline-icon large"><CalendarClock /></span><div><strong className="task-detail-label">更新时间</strong><span className="task-detail-file-value" title={savedAtLabel}>{savedAtLabel || '未知'}</span></div></section>
            </div>
            {!terminal && <section className="task-detail-section task-detail-progress">
              <div className="task-detail-section-heading"><span><Gauge /></span><div><small>{phaseLabel(task)}</small><strong>{task.totalBytes > 0 ? `${Math.round(progress * 100)}%` : '下载进度'}</strong></div><span className="task-detail-progress-size">{task.totalBytes > 0 ? `${formatBytes(task.downloadedBytes)} / ${formatBytes(task.totalBytes)}` : `${formatBytes(task.downloadedBytes)} 已下载`}</span></div>
              <span className={`task-progress-bar ${task.totalBytes <= 0 ? 'indeterminate' : ''}`}><span style={{ width: `${Math.round(progress * 100)}%` }} /></span>
              <small className="task-detail-progress-meta">{task.speedBps > 0 ? `${formatBytes(task.speedBps)}/s` : '正在准备下载'}{remainingSeconds > 0 ? ` · ${formatDuration(remainingSeconds)}` : ''}</small>
            </section>}
            {errorDetails && <section className="task-detail-error"><CircleAlert /><div><strong>错误原因</strong><p>{errorDetails}</p></div></section>}
          </div>
        </section>
      </div>, document.body)}
    </div>
  )
}
