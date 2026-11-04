import { useEffect, useState } from 'react'
import { AlertTriangle, Check, FolderOpen, LoaderCircle, Monitor, Play, RotateCw, Square } from 'lucide-react'
import { upscaleFileNameSchema, type UpscaleCapability, type UpscaleMedia, type UpscaleTask } from '@mediagrab/shared'
import { request } from '../api'
import { chooseUpscalePath, isDesktop, openDownloadFile, type UpscaleSelection } from '../native'
import './upscale.css'

const statusLabels = { queued: '排队中', running: '处理中', succeeded: '已校验并完成', failed: '失败', cancelled: '已取消', interrupted: '已中断，请重新创建' }
const stageLabels = { queued: '等待引擎', probing: '探测与安全检查', decoding: '解码', upscaling: '动漫模型推理', encoding: '编码', validating: '校验成片', done: '完成' }
const active = (task: UpscaleTask): boolean => task.status === 'queued' || task.status === 'running'
function describe(media: UpscaleMedia): string {
  const [n, d = '1'] = media.fps.split('/')
  return `${media.width}×${media.height} → ${media.width * 2}×${media.height * 2} · ${(Number(n) / Number(d)).toFixed(3)} fps · ${media.duration.toFixed(2)} 秒 · ${media.frames} 帧 · ${media.audio ? 'AAC 原样复制' : '无音轨'}`
}
export function UpscalePage() {
  const [cap, setCap] = useState<UpscaleCapability | null>(null)
  const [tasks, setTasks] = useState<UpscaleTask[]>([])
  const [input, setInput] = useState<UpscaleSelection | null>(null)
  const [directory, setDirectory] = useState<UpscaleSelection | null>(null)
  const [name, setName] = useState('')
  const [preview, setPreview] = useState<{ grant: string; media: UpscaleMedia } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [refresh, setRefresh] = useState(0)
  useEffect(() => {
    if (!isDesktop()) { setError('本地超分仅供已验证的 macOS Apple Silicon 桌面会话使用。'); return }
    let stopped = false
    let timer: ReturnType<typeof setTimeout>
    void request<UpscaleCapability>('/api/upscale/capability').then((c) => { if (!stopped) setCap(c) }).catch((e: Error) => { if (!stopped) setError(e.message) })
    const poll = async () => {
      try {
        const result = await request<{ tasks: UpscaleTask[] }>('/api/upscale/tasks')
        if (!stopped) setTasks(result.tasks)
      } catch (e) { if (!stopped) setError((e as Error).message) }
      if (!stopped) timer = setTimeout(() => void poll(), 1000)
    }
    void poll()
    return () => { stopped = true; clearTimeout(timer) }
  }, [refresh])
  const perform = async (fn: () => Promise<void>) => {
    setBusy(true); setError('')
    try { await fn() } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  const choose = (kind: 'input' | 'directory') => perform(async () => {
    const value = await chooseUpscalePath(kind)
    if (!value) return
    setPreview(null)
    if (kind === 'input') {
      setInput(value)
      setName(`${value.path.split('/').pop()?.replace(/\.mp4$/i, '') ?? 'video'}-anime-2x.mp4`)
    } else setDirectory(value)
  })
  const probe = () => perform(async () => {
    if (!input || !directory) return
    setPreview(await request('/api/upscale/grants', { method: 'POST', body: JSON.stringify({ input, directory }) }))
  })
  const start = () => perform(async () => {
    if (!preview) return
    const parsed = upscaleFileNameSchema.safeParse(name)
    if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? '输出文件名不合法')
    const grant = preview.grant
    setPreview(null)
    const task = await request<UpscaleTask>('/api/upscale/tasks', { method: 'POST', body: JSON.stringify({ grant, fileName: name }) })
    setTasks((old) => [task, ...old.filter((t) => t.id !== task.id)])
  })
  return <section className="upscale-page" aria-labelledby="upscale-title">
    <header className="upscale-heading">
      <span className="upscale-heading-icon"><Monitor aria-hidden="true" /></span>
      <div><h1 id="upscale-title">视频超分</h1><p>本地动漫 2× 增强 <span aria-hidden="true">·</span> 不补帧 <span aria-hidden="true">·</span> 不上传</p></div>
    </header>
    <div className="upscale-content">
      <section className="panel upscale-form" aria-labelledby="upscale-create-title">
        <div className="upscale-panel-heading"><div><h2 id="upscale-create-title">创建任务</h2><p>选择源视频和保存位置，检查媒体信息后开始处理。</p></div>
          <span className={`upscale-engine ${cap?.available ? 'ready' : cap ? 'unavailable' : 'checking'}`} role="status">
            <i />{cap?.available ? '本地引擎就绪' : cap ? '引擎不可用' : '正在检查引擎'}
          </span>
        </div>
        <div className="upscale-model"><Monitor aria-hidden="true" /><span><strong>Real-ESRGAN AnimeVideo</strong><small>2× · realesr-animevideov3-x2</small></span>
          {cap?.available && <Check className="upscale-model-check" aria-label="模型可用" />}
        </div>
        {cap && !cap.available && <div className="upscale-capability" role="status"><AlertTriangle /><span>{cap.reason}</span><button className="upscale-button secondary" type="button" onClick={() => { setCap(null); setError(''); setRefresh((v) => v + 1) }}><RotateCw />重新检查</button></div>}
        <div className="upscale-fields">
          <div className="upscale-field"><label>输入视频</label><div className="upscale-picker"><button className="upscale-button secondary" type="button" disabled={busy || !cap?.available} onClick={() => void choose('input')}><FolderOpen />选择 MP4</button><span title={input?.path}>{input?.path ?? '尚未选择文件'}</span></div></div>
          <div className="upscale-field"><label>输出目录</label><div className="upscale-picker"><button className="upscale-button secondary" type="button" disabled={busy || !cap?.available} onClick={() => void choose('directory')}><FolderOpen />选择目录</button><span title={directory?.path}>{directory?.path ?? '尚未选择目录'}</span></div></div>
          <label className="upscale-name"><span>输出文件名</span><input value={name} onChange={(e) => setName(e.target.value)} placeholder="video-anime-2x.mp4" disabled={busy} /></label>
        </div>
        {preview && <div className="upscale-preview"><Check /><div><strong>媒体检查通过</strong><span>{describe(preview.media)}</span></div></div>}
        <div className="upscale-form-footer"><p>支持 macOS Apple Silicon、SDR 恒定帧率 H.264 / MP4，最高 1080p、10 分钟。始终创建新文件，不覆盖原片。</p>
          <div className="upscale-actions"><button className="upscale-button secondary" type="button" disabled={busy || !input || !directory || !cap?.available} onClick={() => void probe()}>{busy ? <LoaderCircle className="spin" /> : <Monitor />}探测媒体</button><button className="upscale-button primary" type="button" disabled={busy || !preview || !name} onClick={() => void start()}>{busy ? <LoaderCircle className="spin" /> : <Play />}开始 2× 超分</button></div>
        </div>
        {error && <p className="upscale-error" role="alert"><AlertTriangle />{error}</p>}
      </section>
      <section className="panel upscale-jobs" aria-labelledby="upscale-jobs-title">
        <div className="upscale-jobs-heading"><h2 id="upscale-jobs-title">任务队列</h2><span>{tasks.length}</span></div>
        <div className="upscale-job-list">
        {tasks.length === 0 && <div className="upscale-empty"><Monitor /><strong>暂无超分任务</strong><p>创建任务后，处理进度和成片会显示在这里。</p></div>}
        {tasks.map((task) => <article className="upscale-job" key={task.id}>
          <div className="upscale-job-title"><strong title={task.input}>{task.input.split('/').pop()}</strong><span className={`upscale-task-status ${task.status}`}>{statusLabels[task.status]}</span></div>
          {task.media && <p className="upscale-media-summary">{describe(task.media)}</p>}
          <div className="upscale-progress-label"><span>{stageLabels[task.stage]}{task.status === 'running' && ' · 批次处理中'}</span><span>{task.completedFrames} / {task.media?.frames ?? '?'} 帧</span></div>
          <progress aria-label="超分进度" max={100} value={task.status === 'succeeded' ? 100 : task.media ? Math.min(99, task.completedFrames / task.media.frames * 99) : undefined} />
          <p className="upscale-path" title={task.output}>{task.output}</p>
          {task.error && <p className="upscale-error" role="alert"><AlertTriangle />{task.error.message}</p>}
          <div className="upscale-job-actions">{active(task) && <button className="upscale-button secondary" type="button" disabled={busy} onClick={() => void perform(async () => { await request(`/api/upscale/tasks/${task.id}/cancel`, { method: 'POST' }) })}><Square />取消任务</button>}
            {task.status === 'succeeded' && task.result && <button className="upscale-button secondary" type="button" onClick={() => void perform(async () => { const parts = task.result!.path.split('/'); const file = parts.pop()!; await openDownloadFile(parts.join('/'), file) })}><FolderOpen />打开成片</button>}</div>
        </article>)}
        </div>
      </section>
    </div>
  </section>
}
