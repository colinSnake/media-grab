import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { AlertTriangle, Check, LoaderCircle, Monitor, Play, RotateCw } from 'lucide-react'
import { upscaleFileNameSchema, type UpscaleCapability, type UpscaleMedia, type UpscaleTask } from '@mediagrab/shared'
import { request } from '../api'
import { chooseUpscalePath, isDesktop, openDownloadFile, type UpscaleSelection } from '../native'
import { UpscalePathPicker } from './UpscalePathPicker'
import { UpscaleTaskCard } from './UpscaleTaskCard'
import { UpscaleTaskFilter, type UpscaleTaskFilterValue } from './UpscaleTaskFilter'
import { UpscaleEngineStatus } from './UpscaleEngineStatus'
import { UpscaleProbeLoader, type UpscalePreview } from '../lib/upscale-probe'
import './upscale.css'

function describe(media: UpscaleMedia): string {
  const [n, d = '1'] = media.fps.split('/')
  return `${media.width}×${media.height} → ${media.width * 2}×${media.height * 2} · ${(Number(n) / Number(d)).toFixed(3)} fps · ${media.duration.toFixed(2)} 秒 · ${media.frames} 帧 · ${media.audio ? 'AAC 原样复制' : '无音轨'}`
}
export function UpscalePage({ engineSlot }: { engineSlot?: HTMLElement | null } = {}) {
  const [cap, setCap] = useState<UpscaleCapability | null>(null)
  const [engineError, setEngineError] = useState('')
  const [tasks, setTasks] = useState<UpscaleTask[]>([])
  const [taskFilter, setTaskFilter] = useState<UpscaleTaskFilterValue>('all')
  const [input, setInput] = useState<UpscaleSelection | null>(null)
  const [directory, setDirectory] = useState<UpscaleSelection | null>(null)
  const [name, setName] = useState('')
  const [preview, setPreview] = useState<UpscalePreview | null>(null)
  const [picking, setPicking] = useState(false)
  const [probing, setProbing] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [queueBusy, setQueueBusy] = useState(false)
  const [probeError, setProbeError] = useState('')
  const [probeRevision, setProbeRevision] = useState(0)
  const [probeLoader] = useState(() => new UpscaleProbeLoader((selection) => request<UpscalePreview>('/api/upscale/grants', { method: 'POST', body: JSON.stringify(selection) })))
  const starting = useRef(false)
  const formBusy = picking || probing || submitting
  const [error, setError] = useState('')
  const [refresh, setRefresh] = useState(0)
  const removedIds = useRef(new Set<string>())
  const parsedName = upscaleFileNameSchema.safeParse(name)
  const nameError = name !== '' && !parsedName.success ? parsedName.error.issues[0]?.message : undefined
  const visibleTasks = tasks.filter((task) => taskFilter === 'all' || task.status === taskFilter)
  useEffect(() => {
    if (!isDesktop()) { setEngineError('本地超分仅供已验证的 macOS Apple Silicon 桌面会话使用。'); return }
    let stopped = false
    let timer: ReturnType<typeof setTimeout>
    void request<UpscaleCapability>('/api/upscale/capability').then((c) => { if (!stopped) setCap(c) }).catch((e: Error) => { if (!stopped) setEngineError(e.message) })
    const poll = async () => {
      try {
        const result = await request<{ tasks: UpscaleTask[] }>('/api/upscale/tasks')
        if (!stopped) setTasks(result.tasks.filter((task) => !removedIds.current.has(task.id)))
      } catch (e) { if (!stopped) setError((e as Error).message) }
      if (!stopped) timer = setTimeout(() => void poll(), 1000)
    }
    void poll()
    return () => { stopped = true; clearTimeout(timer) }
  }, [refresh])
  useEffect(() => {
    let current = true
    setPreview(null); setProbeError('')
    if (!input || !directory || !cap?.available) { setProbing(false); return }
    setProbing(true)
    void probeLoader.prepare({ input, directory }).then((value) => {
      if (current) setPreview(value)
    }).catch((e: unknown) => {
      if (current) setProbeError(e instanceof Error ? e.message : String(e))
    }).finally(() => { if (current) setProbing(false) })
    return () => { current = false }
  }, [input, directory, cap?.available, probeRevision, probeLoader])
  const perform = async (fn: () => Promise<void>) => {
    setQueueBusy(true); setError('')
    try { await fn() } catch (e) { setError((e as Error).message) } finally { setQueueBusy(false) }
  }
  const choose = async (kind: 'input' | 'directory') => {
    if (formBusy || starting.current) return
    setPicking(true); setError('')
    try {
      const value = await chooseUpscalePath(kind)
      if (!value) return
      probeLoader.invalidate(); setPreview(null); setProbeError('')
      if (kind === 'input') {
        setInput(value)
        setName(`${value.path.split('/').pop()?.replace(/\.mp4$/i, '') ?? 'video'}-anime-2x.mp4`)
      } else setDirectory(value)
    } catch (e) { setError((e as Error).message) } finally { setPicking(false) }
  }
  const start = async () => {
    if (starting.current || formBusy || !input || !directory || !preview || !cap?.available) return
    const parsed = upscaleFileNameSchema.safeParse(name)
    if (!parsed.success) { setError(parsed.error.issues[0]?.message ?? '输出文件名不合法'); return }
    starting.current = true
    setError(''); setName(parsed.data)
    let creating = false
    try {
      const selection = { input, directory }
      let checked = probeLoader.peek(selection)
      if (!checked) {
        setProbing(true); setProbeError('')
        checked = await probeLoader.prepare(selection)
        setPreview(checked)
      }
      setProbing(false); setSubmitting(true); creating = true
      // Grants are single-use, including requests whose network response is lost.
      // Keep the checked media visible; a subsequent submission will check again.
      probeLoader.invalidate()
      const task = await request<UpscaleTask>('/api/upscale/tasks', { method: 'POST', body: JSON.stringify({ grant: checked.grant, fileName: parsed.data }) })
      setTasks((old) => [task, ...old.filter((t) => t.id !== task.id)])
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      if (creating) setError(message)
      else { setPreview(null); setProbeError(message) }
    } finally { starting.current = false; setProbing(false); setSubmitting(false) }
  }
  const retryEngine = () => { setCap(null); setEngineError(''); setError(''); setRefresh((v) => v + 1) }
  return <section className="upscale-page" aria-label="视频超分">
    {engineSlot && createPortal(<UpscaleEngineStatus capability={cap} error={engineError} onRetry={retryEngine} />, engineSlot)}
    <div className="upscale-content">
      <section className="panel upscale-form" aria-labelledby="upscale-create-title">
        <div className="panel-heading upscale-panel-heading"><h2 id="upscale-create-title"><span className="heading-main">一键超分</span></h2></div>
        {(engineError || (cap && !cap.available)) && <div className="upscale-capability" role="status"><AlertTriangle /><span>{engineError || cap?.reason || '本地超分引擎不可用，请检查依赖后重试。'}</span><button className="upscale-button secondary" type="button" onClick={retryEngine}><RotateCw />重新检查</button></div>}
        <div className="upscale-fields">
          <UpscalePathPicker kind="input" path={input?.path} disabled={formBusy || !cap?.available} onChoose={() => void choose('input')} />
          <UpscalePathPicker kind="directory" path={directory?.path} disabled={formBusy || !cap?.available} onChoose={() => void choose('directory')} />
          <label className="upscale-name"><span>输出文件名</span><div className="upscale-name-control"><input value={name} onChange={(e) => setName(e.target.value)} onBlur={() => { if (parsedName.success) setName(parsedName.data) }} placeholder="video-anime-2x.mp4" disabled={formBusy} aria-invalid={Boolean(nameError)} aria-describedby="upscale-name-hint" /><small id="upscale-name-hint" className={nameError ? 'upscale-name-error' : undefined}>{nameError ?? '只需填写名称，未写后缀时自动补充 .mp4'}</small></div></label>
        </div>
        {probing ? <div className="upscale-preview checking" role="status"><LoaderCircle className="spin" /><div><strong>正在自动检查素材</strong><span>正在检查视频、时间线和输出目录，请稍候。</span></div></div>
          : probeError ? <div className="upscale-preview failed" role="alert"><AlertTriangle /><div><strong>素材检查未通过</strong><span>{probeError}</span></div><button className="icon-button upscale-probe-retry" type="button" data-tooltip="重新检查素材" aria-label="重新检查素材" disabled={picking || submitting} onClick={() => { probeLoader.invalidate(); setProbeRevision((v) => v + 1) }}><RotateCw /></button></div>
          : preview && <div className="upscale-preview" role="status"><Check /><div><strong>媒体检查通过</strong><span>{describe(preview.media)}</span></div></div>}
        <div className="upscale-form-footer"><p>H.264 / MP4 · ≤1080p · ≤10 分钟 · 不覆盖原片</p>
          <div className="upscale-actions"><button className="upscale-button primary" type="button" disabled={formBusy || !preview || !parsedName.success || !cap?.available} aria-busy={submitting} onClick={() => void start()}>{submitting ? <LoaderCircle className="spin" /> : <Play />}发起超分</button></div>
        </div>
        {error && <p className="upscale-error" role="alert"><AlertTriangle />{error}</p>}
      </section>
      <section className="panel upscale-jobs" aria-labelledby="upscale-jobs-title">
        <div className="panel-heading upscale-jobs-heading"><div className="heading-title"><h2 id="upscale-jobs-title"><span className="heading-main">任务队列</span><small className="heading-count">（{visibleTasks.length}项）</small></h2></div><UpscaleTaskFilter value={taskFilter} onChange={setTaskFilter} /></div>
        <div className="upscale-job-list">
        {visibleTasks.length === 0 && <div className="upscale-empty"><Monitor /><strong>{tasks.length === 0 ? '暂无超分任务' : '暂无符合条件的任务'}</strong><p>{tasks.length === 0 ? '发起超分后，处理进度和成片会显示在这里。' : '切换任务状态查看其他记录。'}</p></div>}
        {visibleTasks.map((task) => <UpscaleTaskCard key={task.id} task={task} busy={queueBusy}
          onRemove={(item) => void perform(async () => {
            await request<void>(`/api/upscale/tasks/${item.id}`, { method: 'DELETE' })
            removedIds.current.add(item.id)
            setTasks((old) => old.filter((task) => task.id !== item.id))
          })}
          onCancel={(item) => void perform(async () => { await request(`/api/upscale/tasks/${item.id}/cancel`, { method: 'POST' }) })}
          onOpen={(item) => void perform(async () => { if (!item.result) return; const parts = item.result.path.split('/'); const file = parts.pop()!; await openDownloadFile(parts.join('/'), file) })}
        />)}
        </div>
      </section>
    </div>
  </section>
}
