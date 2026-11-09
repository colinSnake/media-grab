import { useEffect, useRef, useState, type PointerEvent } from 'react'
import { AlertTriangle, Check, LoaderCircle, Monitor, Play, RotateCw, Sparkles, Trash2, Undo2 } from 'lucide-react'
import { upscaleFileNameSchema, upscaleImageFileNameSchema, type RepairStrokes, type UpscaleKind, type UpscaleMedia, type UpscaleTask } from '@mediagrab/shared'
import { fetchWithCoreAuth, RequestError, request } from '../api'
import { chooseUpscalePath, isDesktop, openDownloadFile, type UpscaleSelection } from '../native'
import { UpscalePathPicker } from './UpscalePathPicker'
import { UpscaleTaskCard } from './UpscaleTaskCard'
import { UpscaleTaskFilter, type UpscaleTaskFilterValue } from './UpscaleTaskFilter'
import { useUpscaleEngine } from './UpscaleEngineProvider'
import { UpscaleProbeLoader, type UpscalePreview } from '../lib/upscale-probe'
import { RepairPreviewRequests, repairResponseError } from '../lib/repair-preview'
import './upscale.css'

function describe(media: UpscaleMedia, kind: UpscaleKind): string {
  const dimensions = `${media.width}×${media.height} → ${media.width * 2}×${media.height * 2}`
  if (kind === 'image') return `${dimensions} · 单张图片 · PNG 输出`
  const [n, d = '1'] = media.fps.split('/')
  return `${dimensions} · ${(Number(n) / Number(d)).toFixed(3)} fps · ${media.duration.toFixed(2)} 秒 · ${media.frames} 帧 · ${media.audio ? 'AAC 原样复制' : '无音轨'}`
}
export function UpscalePage() {
  const { capability: cap, error: engineError, retry: retryEngine } = useUpscaleEngine()
  const [kind, setKind] = useState<UpscaleKind>('video')
  const [tasks, setTasks] = useState<UpscaleTask[]>([])
  const [taskFilter, setTaskFilter] = useState<UpscaleTaskFilterValue>('all')
  const [input, setInput] = useState<UpscaleSelection | null>(null)
  const [directory, setDirectory] = useState<UpscaleSelection | null>(null)
  const [name, setName] = useState('')
  const [preview, setPreview] = useState<UpscalePreview | null>(null)
  const [repairEnabled, setRepairEnabled] = useState(false)
  const [strokes, setStrokes] = useState<RepairStrokes>([])
  const [sourcePreviewUrl, setSourcePreviewUrl] = useState('')
  const [repairPreviewUrl, setRepairPreviewUrl] = useState('')
  const [repairBusy, setRepairBusy] = useState(false)
  const [repairRequests] = useState(() => new RepairPreviewRequests())
  const [repairError, setRepairError] = useState('')
  const [brushSize, setBrushSize] = useState(4)
  const [canvasRevision, setCanvasRevision] = useState(0)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const activeStroke = useRef<number | null>(null)
  const strokesRef = useRef<RepairStrokes>([])
  const clearStrokes = () => { strokesRef.current = []; setStrokes([]) }
  const [picking, setPicking] = useState(false)
  const [probing, setProbing] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [queueBusy, setQueueBusy] = useState(false)
  const [probeError, setProbeError] = useState('')
  const [probeRevision, setProbeRevision] = useState(0)
  const [probeLoader] = useState(() => new UpscaleProbeLoader((selection) => request<UpscalePreview>('/api/upscale/grants', { method: 'POST', body: JSON.stringify(selection) })))
  const starting = useRef(false)
  const [localStorageReason, setLocalStorageReason] = useState('')
  const [runtimeStorageReason, setRuntimeStorageReason] = useState('')
  const formBusy = picking || probing || submitting || repairBusy
  const imageUnavailable = kind === 'image' && cap?.available === true && cap.imageAvailable !== true
  const repairUnavailable = cap?.repairAvailable !== true
  const storageReason = localStorageReason || runtimeStorageReason || cap?.storageReason || tasks.find((task) => task.storageWarning)?.storageWarning
  const inputDisabled = formBusy || !cap?.available || imageUnavailable || Boolean(storageReason)
  const [error, setError] = useState('')
  const removedIds = useRef(new Set<string>())
  const fileNameSchema = kind === 'image' ? upscaleImageFileNameSchema : upscaleFileNameSchema
  const parsedName = fileNameSchema.safeParse(name)
  const nameError = name !== '' && !parsedName.success ? parsedName.error.issues[0]?.message : undefined
  const visibleTasks = tasks.filter((task) => taskFilter === 'all' || task.status === taskFilter)
  useEffect(() => {
    if (!isDesktop()) return
    let stopped = false
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      try {
        const result = await request<{ tasks: UpscaleTask[]; storageReason?: string }>('/api/upscale/tasks')
        if (!stopped) { setTasks(result.tasks.filter((task) => !removedIds.current.has(task.id))); setRuntimeStorageReason(result.storageReason ?? '') }
      } catch (e) { if (!stopped) setError((e as Error).message) }
      if (!stopped) timer = setTimeout(() => void poll(), 1000)
    }
    void poll()
    return () => { stopped = true; clearTimeout(timer) }
  }, [])
  useEffect(() => {
    let current = true
    setPreview(null); setProbeError('')
    if (!input || !directory || !cap?.available) { setProbing(false); return }
    setProbing(true)
    void probeLoader.prepare({ input, directory, kind }).then((value) => {
      if (current) setPreview(value)
    }).catch((e: unknown) => {
      if (current) setProbeError(e instanceof Error ? e.message : String(e))
    }).finally(() => { if (current) setProbing(false) })
    return () => { current = false }
  }, [input, directory, kind, cap?.available, probeRevision, probeLoader])
  useEffect(() => {
    let current = true
    setSourcePreviewUrl(''); setRepairError('')
    if (!preview || kind !== 'image' || !repairEnabled) return
    const controller = new AbortController()
    void fetchWithCoreAuth(`/api/upscale/grants/${encodeURIComponent(preview.grant)}/thumbnail`, controller.signal).then(async (response) => {
      if (!response.ok) throw new Error('无法加载图片预览，请重新选择图片')
      const url = URL.createObjectURL(await response.blob())
      if (current) setSourcePreviewUrl(url); else URL.revokeObjectURL(url)
    }).catch((e: unknown) => { if (current) setRepairError(e instanceof Error ? e.message : String(e)) })
    return () => { current = false; controller.abort() }
  }, [preview, kind, repairEnabled])
  useEffect(() => {
    repairRequests.cancel(); setRepairBusy(false); setRepairPreviewUrl(''); clearStrokes(); setRepairError('')
  }, [input, directory, kind, repairEnabled, repairRequests])
  useEffect(() => () => repairRequests.cancel(), [repairRequests])
  useEffect(() => () => { if (sourcePreviewUrl) URL.revokeObjectURL(sourcePreviewUrl) }, [sourcePreviewUrl])
  useEffect(() => () => { if (repairPreviewUrl) URL.revokeObjectURL(repairPreviewUrl) }, [repairPreviewUrl])
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => setCanvasRevision((value) => value + 1))
    observer.observe(canvas)
    return () => observer.disconnect()
  }, [sourcePreviewUrl])
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !sourcePreviewUrl) return
    const image = new Image()
    let active = true
    image.onload = () => {
      if (!active) return
      const rect = canvas.getBoundingClientRect(), scale = window.devicePixelRatio || 1
      canvas.width = Math.round(rect.width * scale); canvas.height = Math.round(rect.height * scale)
      const context = canvas.getContext('2d')
      if (!context) return
      context.setTransform(scale, 0, 0, scale, 0, 0)
      context.clearRect(0, 0, rect.width, rect.height); context.lineCap = 'round'; context.lineJoin = 'round'
      const imageAspect = preview ? preview.media.width / preview.media.height : image.naturalWidth / image.naturalHeight, boxAspect = rect.width / rect.height
      const drawWidth = imageAspect > boxAspect ? 1 : imageAspect / boxAspect, drawHeight = imageAspect > boxAspect ? boxAspect / imageAspect : 1
      const offsetX = (1 - drawWidth) / 2, offsetY = (1 - drawHeight) / 2
      context.globalAlpha = 1; context.drawImage(image, offsetX * rect.width, offsetY * rect.height, drawWidth * rect.width, drawHeight * rect.height)
      context.globalAlpha = 1
      for (const stroke of strokes) {
        const brushRadius = stroke.radius * Math.min(drawWidth * rect.width, drawHeight * rect.height)
        context.lineWidth = brushRadius * 2
        const points = stroke.points.map((point) => ({ x: (offsetX + point.x * drawWidth) * rect.width, y: (offsetY + point.y * drawHeight) * rect.height }))
        context.strokeStyle = 'rgba(239, 68, 68, .48)'; context.fillStyle = 'rgba(239, 68, 68, .48)'
        if (points.length === 1) { const point = points[0]!; context.beginPath(); context.arc(point.x, point.y, brushRadius, 0, Math.PI * 2); context.fill() }
        else { context.beginPath(); context.moveTo(points[0]!.x, points[0]!.y); for (const point of points.slice(1)) context.lineTo(point.x, point.y); context.stroke() }
      }
    }
    image.src = sourcePreviewUrl
    return () => { active = false; image.onload = null }
  }, [sourcePreviewUrl, strokes, preview, canvasRevision])
  const perform = async (fn: () => Promise<void>) => {
    setQueueBusy(true); setError('')
    try { await fn() } catch (e) { setError((e as Error).message) } finally { setQueueBusy(false) }
  }
  const choose = async (selectionKind: 'input' | 'directory') => {
    if (formBusy || starting.current) return
    setPicking(true); setError('')
    try {
      const value = await chooseUpscalePath(selectionKind === 'directory' ? 'directory' : kind === 'image' ? 'image' : 'input')
      if (!value) return
      probeLoader.invalidate(); setPreview(null); setProbeError('')
      if (selectionKind === 'input') {
        setInput(value)
        const base = value.path.split('/').pop()?.replace(/\.[^.]+$/, '') ?? (kind === 'image' ? 'image' : 'video')
        setName(`${base}-anime-2x.${kind === 'image' ? 'png' : 'mp4'}`)
      } else setDirectory(value)
    } catch (e) { setError((e as Error).message) } finally { setPicking(false) }
  }
  const changeKind = (next: UpscaleKind) => {
    if (next === kind || formBusy || starting.current) return
    setKind(next); setInput(null); setName(''); setPreview(null); setProbeError(''); setError('')
    setRepairEnabled(false); setRepairPreviewUrl(''); clearStrokes()
    probeLoader.invalidate()
  }
  const start = async () => {
    if (starting.current || formBusy || imageUnavailable || storageReason || !input || !directory || !preview || !cap?.available || (repairEnabled && (!repairPreviewUrl || strokes.length === 0))) return
    const parsed = fileNameSchema.safeParse(name)
    if (!parsed.success) { setError(parsed.error.issues[0]?.message ?? '输出文件名不合法'); return }
    starting.current = true
    setError(''); setName(parsed.data)
    let creating = false
    try {
      const selection = { input, directory, kind }
      let checked = probeLoader.peek(selection)
      if (!checked) {
        setProbing(true); setProbeError('')
        checked = await probeLoader.prepare(selection)
        setPreview(checked)
        if (repairEnabled) {
          setRepairPreviewUrl(''); setRepairError('素材授权已更新，请重新生成修补预览后再确认')
          return
        }
      }
      setProbing(false); setSubmitting(true); creating = true
      // Grants are single-use, including requests whose network response is lost.
      // Keep the checked media visible; a subsequent submission will check again.
      probeLoader.invalidate()
      const task = await request<UpscaleTask>('/api/upscale/tasks', { method: 'POST', body: JSON.stringify({ grant: checked.grant, kind, fileName: parsed.data, ...(repairEnabled ? { repair: strokes } : {}) }) })
      setTasks((old) => [task, ...old.filter((t) => t.id !== task.id)])
      setInput(null); setDirectory(null); setName(''); setPreview(null); setProbeError(''); setRepairPreviewUrl(''); setRepairEnabled(false); clearStrokes()
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      if (e instanceof RequestError && ['STORAGE_FULL', 'STORAGE_ERROR'].includes(e.code ?? '')) setLocalStorageReason(message)
      if (creating) setError(message)
      else { setPreview(null); setProbeError(message) }
    } finally { starting.current = false; setProbing(false); setSubmitting(false) }
  }
  const updateStroke = (event: PointerEvent<HTMLCanvasElement>, append: boolean) => {
    const rect = event.currentTarget.getBoundingClientRect()
    if (!preview || formBusy || !sourcePreviewUrl) return
    const imageAspect = preview.media.width / preview.media.height, boxAspect = rect.width / rect.height
    const drawWidth = imageAspect > boxAspect ? 1 : imageAspect / boxAspect, drawHeight = imageAspect > boxAspect ? boxAspect / imageAspect : 1
    const offsetX = (1 - drawWidth) / 2, offsetY = (1 - drawHeight) / 2
    const x = ((event.clientX - rect.left) / rect.width - offsetX) / drawWidth
    const y = ((event.clientY - rect.top) / rect.height - offsetY) / drawHeight
    if (x < 0 || x > 1 || y < 0 || y > 1) return
    const point = { x, y }
    setRepairPreviewUrl(''); setRepairError('')
    const current = strokesRef.current
    if (append && (current.length >= 80 || current.reduce((total, stroke) => total + stroke.points.length, 0) >= 4096)) { setRepairError('选区笔画已达到上限，请清除部分选区后继续'); return }
    const pointCount = current.reduce((total, stroke) => total + stroke.points.length, 0)
    if (!append && (pointCount >= 4096 || current.at(-1)?.points.length! >= 256)) { setRepairError('选区点数已达到上限，请生成预览或清除选区'); return }
    const next = append ? [...current, { radius: brushSize / 100, points: [point] }] : current.map((stroke, index) => index === current.length - 1 ? { ...stroke, points: [...stroke.points, point] } : stroke)
    strokesRef.current = next
    setStrokes(next)
    return true
  }
  const generateRepairPreview = async () => {
    if (!preview || !input || !directory || strokes.length === 0 || repairBusy || repairUnavailable) return
    const ticket = repairRequests.start()
    setRepairBusy(true); setRepairError(''); setRepairPreviewUrl('')
    try {
      const selection = { input, directory, kind }
      const checked = probeLoader.peek(selection) ?? await probeLoader.prepare(selection)
      if (!ticket.current()) return
      setPreview(checked)
      const response = await fetchWithCoreAuth(`/api/upscale/grants/${encodeURIComponent(checked.grant)}/repair-preview`, ticket.signal, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ strokes }) })
      if (!response.ok) throw await repairResponseError(response)
      const blob = await response.blob()
      if (ticket.current()) setRepairPreviewUrl(URL.createObjectURL(blob))
    } catch (e) {
      if (ticket.current()) setRepairError(e instanceof Error ? e.message : String(e))
    } finally { if (ticket.current()) setRepairBusy(false) }
  }
  const cancelRepairPreview = () => {
    repairRequests.cancel(); setRepairBusy(false); setRepairPreviewUrl(''); setRepairError('修补预览已取消')
  }

  return <section className="upscale-page" aria-label="媒体超分">
    <div className="upscale-content">
      <section className="panel upscale-form" aria-labelledby="upscale-create-title">
        <div className="panel-heading upscale-panel-heading"><h2 id="upscale-create-title"><span className="heading-main">一键超分</span></h2><div className="upscale-kind-switch" role="group" aria-label="选择超分媒体类型"><button type="button" aria-pressed={kind === 'video'} className={kind === 'video' ? 'selected' : ''} disabled={formBusy} onClick={() => changeKind('video')}>视频</button><button type="button" aria-pressed={kind === 'image'} className={kind === 'image' ? 'selected' : ''} disabled={formBusy} onClick={() => changeKind('image')}>图片</button></div></div>
        {(engineError || (cap && !cap.available) || imageUnavailable || storageReason) && <div className="upscale-capability" role="status"><AlertTriangle /><span>{engineError || storageReason || (imageUnavailable ? cap?.imageReason : cap?.reason) || '本地超分引擎不可用，请检查依赖后重试。'}</span><button className="upscale-button secondary" type="button" onClick={() => { setLocalStorageReason(''); retryEngine() }}><RotateCw />重新检查</button></div>}
        <div className="upscale-fields">
          <UpscalePathPicker kind="input" mediaKind={kind} path={input?.path} disabled={inputDisabled} onChoose={() => void choose('input')} />
          <UpscalePathPicker kind="directory" path={directory?.path} disabled={inputDisabled} onChoose={() => void choose('directory')} />
          <label className="upscale-name"><span>输出文件名</span><div className="upscale-name-control"><input value={name} onChange={(e) => setName(e.target.value)} onBlur={() => { if (parsedName.success) setName(parsedName.data) }} placeholder={kind === 'image' ? 'image-anime-2x.png' : 'video-anime-2x.mp4'} disabled={formBusy} aria-invalid={Boolean(nameError)} aria-describedby="upscale-name-hint" /><small id="upscale-name-hint" className={nameError ? 'upscale-name-error' : undefined}>{nameError ?? `只需填写名称，未写后缀时自动补充 .${kind === 'image' ? 'png' : 'mp4'}`}</small></div></label>
        </div>
        {probing ? <div className="upscale-preview checking" role="status"><LoaderCircle className="spin" /><div><strong>正在自动检查素材</strong><span>正在检查{kind === 'image' ? '图片尺寸' : '视频、时间线'}和输出目录，请稍候。</span></div></div>
          : probeError ? <div className="upscale-preview failed" role="alert"><AlertTriangle /><div><strong>素材检查未通过</strong><span>{probeError}</span></div><button className="icon-button upscale-probe-retry" type="button" data-tooltip="重新检查素材" aria-label="重新检查素材" disabled={picking || submitting} onClick={() => { probeLoader.invalidate(); setProbeRevision((v) => v + 1) }}><RotateCw /></button></div>
          : preview && <div className="upscale-preview" role="status"><Check /><div><strong>媒体检查通过</strong><span>{describe(preview.media, kind)}</span></div></div>}
        {kind === 'image' && <div className="upscale-repair-control">
          <label className="upscale-repair-toggle"><input type="checkbox" checked={repairEnabled} disabled={!input || formBusy || imageUnavailable || (!repairEnabled && repairUnavailable)} onChange={(event) => { setRepairEnabled(event.target.checked); clearStrokes(); setRepairPreviewUrl(''); setRepairError('') }} /><span>修补选定区域</span></label>{repairUnavailable && <p className="upscale-repair-unavailable" role="status">{cap?.repairReason || '图片修补不可用，请检查模型与运行时'}</p>}
          {repairEnabled && <>
            <div className="upscale-repair-toolbar"><label htmlFor="upscale-brush-size">笔刷</label><input id="upscale-brush-size" type="range" min="1" max="12" value={brushSize} onChange={(event) => setBrushSize(Number(event.target.value))} disabled={!sourcePreviewUrl || repairBusy} /><span>{brushSize}</span><button className="icon-button" type="button" data-tooltip="撤销上一笔" aria-label="撤销上一笔" disabled={!strokes.length || repairBusy} onClick={() => { const next = strokesRef.current.slice(0, -1); strokesRef.current = next; setStrokes(next); setRepairPreviewUrl('') }}><Undo2 /></button><button className="icon-button" type="button" data-tooltip="清除选区" aria-label="清除选区" disabled={!strokes.length || repairBusy} onClick={() => { clearStrokes(); setRepairPreviewUrl('') }}><Trash2 /></button></div>
            <div className="upscale-repair-preview-grid">
              <div className="upscale-repair-preview"><span>原图与选区</span>{sourcePreviewUrl ? <canvas ref={canvasRef} aria-label="涂选要修补的区域" aria-disabled={formBusy} onPointerDown={(event) => { if (formBusy || !updateStroke(event, true)) return; event.currentTarget.setPointerCapture(event.pointerId); activeStroke.current = event.pointerId }} onPointerMove={(event) => { if (activeStroke.current === event.pointerId) updateStroke(event, false) }} onPointerUp={(event) => { if (activeStroke.current === event.pointerId) activeStroke.current = null }} onPointerCancel={() => { activeStroke.current = null }} /> : <div className="upscale-repair-empty">{repairError || '选择图片后加载预览'}</div>}</div>
              <div className="upscale-repair-preview"><span>修补结果</span>{repairPreviewUrl ? <img src={repairPreviewUrl} alt="修补预览结果" /> : <div className="upscale-repair-empty">{repairBusy ? <><LoaderCircle className="spin" />正在生成预览</> : '生成预览后在此确认'}</div>}</div>
            </div>
            {repairError && <p className="upscale-error" role="alert"><AlertTriangle />{repairError}</p>}
            <div className="upscale-repair-actions"><button className="upscale-button secondary" type="button" disabled={!strokes.length || repairBusy || !preview || repairUnavailable} onClick={() => void generateRepairPreview()}>{repairBusy ? <LoaderCircle className="spin" /> : <Sparkles />}生成修补预览</button>{repairBusy && <button className="upscale-button secondary" type="button" onClick={cancelRepairPreview}>取消预览</button>}<span>{repairPreviewUrl ? '请确认修补效果后再发起超分' : '仅处理手动画选区域'}</span></div>
          </>}
        </div>}
        <div className="upscale-form-footer"><p>{kind === 'image' ? 'PNG / JPG / JPEG · ≤800 万像素 · PNG 输出 · 不覆盖原图；当前动漫模型更适合插画' : 'H.264 / MP4 · ≤1080p · ≤10 分钟 · 不覆盖原片'}</p>
          <div className="upscale-actions"><button className="upscale-button primary" type="button" disabled={formBusy || !preview || !parsedName.success || !cap?.available || imageUnavailable || Boolean(storageReason) || (repairEnabled && (repairUnavailable || !repairPreviewUrl))} aria-busy={submitting} onClick={() => void start()}>{submitting ? <LoaderCircle className="spin" /> : <Play />}{repairEnabled ? '确认并发起超分' : '发起超分'}</button></div>
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
