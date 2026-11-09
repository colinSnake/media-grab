import { AlertTriangle, ArrowRight, Check, ChevronDown, Clock3, FolderOpen, LoaderCircle, Square, Trash2 } from 'lucide-react'
import { UpscaleTaskCover } from './UpscaleTaskCover'
import type { UpscaleTask } from '@mediagrab/shared'

const statusLabels = { queued: '排队中', running: '处理中', succeeded: '已完成', failed: '处理失败', cancelled: '已取消', interrupted: '已中断' }
const stageLabels = { queued: '等待引擎', probing: '探测与安全检查', decoding: '解码视频', upscaling: '动漫模型推理', encoding: '编码成片', validating: '校验成片', done: '处理完成' }
const fileName = (path: string) => path.split('/').pop() || path

function durationLabel(seconds: number) {
  const whole = Math.max(0, Math.round(seconds))
  return `${String(Math.floor(whole / 60)).padStart(2, '0')}:${String(whole % 60).padStart(2, '0')}`
}

export function UpscaleTaskCard({ task, busy, onCancel, onOpen, onRemove }: {
  task: UpscaleTask
  busy: boolean
  onCancel: (task: UpscaleTask) => void
  onOpen: (task: UpscaleTask) => void
  onRemove: (task: UpscaleTask) => void
}) {
  const media = task.media
  const kind = task.kind ?? 'video'
  const running = task.status === 'running', queued = task.status === 'queued'
  const succeeded = task.status === 'succeeded'
  const knownFrames = media && media.frames > 0 ? media.frames : undefined
  // Frames measure the pipeline's processed output; reserve completion for validation.
  const progress = succeeded ? 100 : knownFrames ? Math.min(99, Math.max(0, task.completedFrames / knownFrames * 99)) : undefined
  const percent = progress === undefined ? '—' : progress > 0 && progress < 1 ? '<1%' : `${Math.floor(progress)}%`
  const [n, d = '1'] = (media?.fps ?? '').split('/')
  const fps = Number(n) / Number(d)
  const stage = succeeded ? kind === 'image' ? '图片校验通过' : '成片校验通过' : queued ? '等待前序任务完成' : task.status === 'cancelled' ? '任务已取消' : task.status === 'interrupted' ? '应用退出导致中断，请重新创建' : task.status === 'failed' ? '处理未完成' : kind === 'image' && task.stage === 'decoding' ? '解码图片' : kind === 'image' && task.stage === 'validating' ? '校验图片' : stageLabels[task.stage]
  return <article className={`upscale-job ${task.status}`} aria-label={`${fileName(task.output)} · ${statusLabels[task.status]}`}>
    <div className="upscale-job-header">
      <UpscaleTaskCover taskId={task.id} kind={kind}>{null}</UpscaleTaskCover>
      <div className="upscale-job-title">
        <div className="upscale-job-title-row"><h3 data-tooltip={fileName(task.output)}>{fileName(task.output)}</h3><span className={`upscale-task-status ${task.status}`}><i aria-hidden="true" />{statusLabels[task.status]}</span></div>
        <p data-tooltip={fileName(task.input)}>源文件 · {fileName(task.input)}</p>
      </div>
    </div>
    {media && <div className="upscale-job-media">
      <div className="upscale-media-block upscale-resolution-block">
        <div className="upscale-media-heading"><span className="upscale-media-label">分辨率</span><span className="upscale-scale-tag">2×</span></div>
        <div className="upscale-resolution"><span>{media.width} × {media.height}</span><ArrowRight aria-hidden="true" /><strong>{media.width * 2} × {media.height * 2}</strong></div>
      </div>
      <div className="upscale-media-block upscale-details-block">
        <span className="upscale-media-label">媒体参数</span>
        <div className="upscale-media-tags">{kind === 'image' ? <><span>单张图片</span><span>PNG 输出</span><span>动漫模型 2×</span></> : <><span>{Number.isFinite(fps) ? `${Number(fps.toFixed(3))} fps` : media.fps}</span><span>{durationLabel(media.duration)}</span><span>{media.audio ? 'AAC 原样保留' : '无音轨'}</span></>}</div>
      </div>
    </div>}
    <div className="upscale-job-progress">
      <div className="upscale-progress-label"><span>{running ? <LoaderCircle className="spin" aria-hidden="true" /> : queued ? <Clock3 aria-hidden="true" /> : succeeded ? <Check aria-hidden="true" /> : task.status === 'failed' || task.status === 'interrupted' ? <AlertTriangle aria-hidden="true" /> : <Square aria-hidden="true" />}{stage}</span><strong>{percent}</strong></div>
      <progress aria-label={`${fileName(task.output)}超分进度`} max={100} value={progress} />
      <div className="upscale-progress-meta"><span>{task.completedFrames.toLocaleString('zh-CN')} / {knownFrames?.toLocaleString('zh-CN') ?? '—'} {kind === 'image' ? '张图片' : '帧'}</span><span>{running ? kind === 'image' ? '单图推理 · 完成后自动校验' : '批次处理 · 完成后自动校验' : succeeded ? kind === 'image' ? '图片尺寸与输出已校验' : '帧数与音轨已校验' : queued ? '按创建顺序处理' : '任务已停止'}</span></div>
    </div>
    {task.storageWarning && <p className="upscale-job-error" role="status"><AlertTriangle aria-hidden="true" /><span>{task.status === 'succeeded' ? '处理结果已保存，但任务记录尚未落盘：' : '任务状态尚未落盘：'}{task.storageWarning}</span></p>}
    {task.error && <p className="upscale-job-error" role="alert"><AlertTriangle aria-hidden="true" /><span>{task.error.message}</span></p>}
    <div className="upscale-job-footer">
      <details className="upscale-job-location"><summary><FolderOpen aria-hidden="true" /><span>输出位置</span><ChevronDown aria-hidden="true" /></summary><p>{task.output}</p></details>
      <div className="upscale-job-actions">
      {(running || queued) && <button className="upscale-button secondary upscale-job-cancel" type="button" disabled={busy} onClick={() => onCancel(task)}><Square aria-hidden="true" />取消任务</button>}
      {succeeded && task.result && <button className="upscale-button secondary upscale-job-open" type="button" disabled={busy} onClick={() => onOpen(task)}><FolderOpen aria-hidden="true" />{kind === 'image' ? '打开图片' : '打开成片'}</button>}
      {!running && <button className="upscale-button secondary upscale-job-remove" type="button" disabled={busy} aria-label={`删除任务 ${fileName(task.output)}`} data-tooltip={kind === 'image' ? "只删除任务记录，不删除源图片或处理结果" : "只删除任务记录，不删除源视频或成片"} onClick={() => onRemove(task)}><Trash2 aria-hidden="true" /><span>删除</span></button>}
      </div>
    </div>
  </article>
}
