import {
  ArrowDownToLine,
  Check,
  Clock3,
  FileVideo2,
  LoaderCircle,
  RotateCcw,
  Trash2,
  X,
} from 'lucide-react'
import { platformLabel, qualityMeta, taskProgress, type TaskSnapshot } from '@mediagrab/shared'
import { PlatformLogo } from './PlatformLogo'

export function isTerminalTask(task: TaskSnapshot): boolean {
  return task.status === 'success' || task.status === 'fail' || task.status === 'stopped'
}

function taskStatusLabel(status: TaskSnapshot['status']): string {
  const labels: Record<TaskSnapshot['status'], string> = {
    waiting: '等待中',
    downloading: '下载中',
    merging: '合并中',
    success: '已完成',
    fail: '失败',
    stopped: '已停止',
  }
  return labels[status]
}

function taskFileUrl(id: string): string {
  return `/api/tasks/${encodeURIComponent(id)}/file`
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
  if (task.phase === 'done' || task.status === 'success') return '已完成'
  return task.status === 'fail' ? '下载失败' : task.status === 'stopped' ? '已停止' : '准备中'
}

export function TaskStatusIndicator({ status, error }: { status: TaskSnapshot['status']; error?: string }) {
  const label = error ? `${taskStatusLabel(status)}：${error}` : taskStatusLabel(status)
  return <span className={`task-indicator ${status}`} aria-label={label} title={label}>
    {status === 'success' ? <Check /> : status === 'fail' ? <X /> : status === 'waiting' || status === 'stopped' ? <Clock3 /> : <LoaderCircle className="spin" />}
  </span>
}

export interface TaskRowProps {
  task: TaskSnapshot
  variant?: 'compact' | 'detail'
  onCancel?: (id: string) => void
  onRetry?: (id: string) => void
  onRemove?: (id: string) => void
}

export function TaskRow({ task, variant = 'detail', onCancel, onRetry, onRemove }: TaskRowProps) {
  const terminal = isTerminalTask(task)
  const title = task.title || task.bvid || task.input
  const modeLabel = task.mode === 'audio'
    ? `音频 ${task.audioContainer ?? 'm4a'}`
    : task.mode === 'video' ? '仅视频' : '视频 + 音频'
  const resolutionLabel = task.qualityLabel ?? (task.qn === undefined ? '' : qualityMeta(task.qn)?.label ?? `${task.qn}P`)
  const progress = task.status === 'success' ? 1 : taskProgress(task)
  const indeterminate = !terminal && task.totalBytes <= 0
  const remainingSeconds = task.speedBps > 0 && task.totalBytes > task.downloadedBytes
    ? (task.totalBytes - task.downloadedBytes) / task.speedBps
    : 0

  return (
    <div className={variant === 'compact' ? 'task-row' : `task-view-row ${terminal ? 'terminal' : ''}`}>
      <span className={`task-platform-icon ${task.platform}`} title={platformLabel[task.platform]}>
        {task.platform === 'unknown' ? <FileVideo2 /> : <PlatformLogo platform={task.platform} />}
      </span>
      <span className="task-title">
        <strong title={title}>{title}</strong>
        <span className="task-meta">
          <span className={`task-mode-tag ${task.mode}`}>{modeLabel}</span>
          {resolutionLabel !== '' && <span className="task-resolution-tag">{resolutionLabel}</span>}
        </span>
        {variant === 'detail' && !terminal && <span className="task-progress-summary">
          <span>{phaseLabel(task)}</span>
          <span>{task.totalBytes > 0 ? `${formatBytes(task.downloadedBytes)} / ${formatBytes(task.totalBytes)}` : `${formatBytes(task.downloadedBytes)} / 大小未知`}</span>
          {task.speedBps > 0 && <span>{formatBytes(task.speedBps)}/s</span>}
          {!terminal && <span>{formatDuration(remainingSeconds)}</span>}
        </span>}
        {variant === 'detail' && !terminal && <span className={`task-progress-bar ${indeterminate ? 'indeterminate' : ''}`} aria-label={`${Math.round(progress * 100)}%`}>
          <span style={{ width: `${Math.round(progress * 100)}%` }} />
        </span>}
        {variant === 'detail' && !terminal && task.error !== '' && <small className="task-error" title={task.error}>{task.error}</small>}
      </span>
      <TaskStatusIndicator status={task.status} error={task.error} />
      {variant === 'detail' && task.status === 'success' && <a className="task-action" title="下载文件" href={taskFileUrl(task.id)} download><ArrowDownToLine /></a>}
      {!terminal && onCancel !== undefined && <button className="task-action" type="button" title="取消任务" onClick={() => onCancel(task.id)}><X /></button>}
      {terminal && task.status !== 'success' && onRetry !== undefined && <button className="task-action" type="button" title="重试任务" onClick={() => onRetry(task.id)}><RotateCcw /></button>}
      {terminal && onRemove !== undefined && <button className="task-action" type="button" title="删除历史任务" onClick={() => onRemove(task.id)}><Trash2 /></button>}
    </div>
  )
}
