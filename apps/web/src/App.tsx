import { useEffect, useMemo, useState } from 'react'
import {
  Activity,
  ArrowDownToLine,
  ArrowRight,
  Check,
  Clock3,
  FileVideo2,
  FolderDown,
  Link2,
  ListChecks,
  LoaderCircle,
  Music2,
  Plus,
  RotateCcw,
  Search,
  Settings2,
  ShieldCheck,
  Trash2,
  UserRound,
  X,
} from 'lucide-react'
import type {
  AccountSummary,
  AppConfig,
  AppConfigPatch,
  AudioContainer,
  DownloadMode,
  MediaParseResult,
  ParseResult,
  QualityAvailability,
  TaskSnapshot,
} from '@mediagrab/shared'
import { activateAccount, cancelTask, createTask, getAccounts, getConfig, getExtractorStatus, getHealth, getTasks, importBiliAccount, parseMedia, parseUniversalMedia, patchConfig, removeAccount, removeTask, retryTask, verifyAccount, type HealthResponse, type ExtractorStatus } from './api'
import logoUrl from './assets/mediagrab-logo.svg'

type Platform = '全部' | 'B站' | '抖音' | '小红书'
type WorkspaceView = 'new' | 'queue' | 'history'

const platformOptions: { label: Platform; tone: string; hint: string }[] = [
  { label: '全部', tone: 'all', hint: '所有来源' },
  { label: 'B站', tone: 'bili', hint: 'bilibili.com' },
  { label: '抖音', tone: 'douyin', hint: 'douyin.com' },
  { label: '小红书', tone: 'rednote', hint: 'xiaohongshu.com' },
]

const modeOptions: { value: DownloadMode; label: string; detail: string }[] = [
  { value: 'video+audio', label: '视频 + 音频', detail: 'MP4 合并' },
  { value: 'video', label: '仅视频', detail: '不含音频' },
  { value: 'audio', label: '仅音频', detail: 'M4A / MP3' },
]

function formatDuration(seconds: number): string {
  if (seconds <= 0) return '--:--'
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  return `${minutes}:${rest.toString().padStart(2, '0')}`
}

function platformFromInput(input: string): Exclude<Platform, '全部'> {
  const normalized = input.toLowerCase()
  if (normalized.includes('douyin') || normalized.includes('iesdouyin')) return '抖音'
  if (normalized.includes('xiaohongshu') || normalized.includes('xhslink')) return '小红书'
  return 'B站'
}

function qualityLabel(item: QualityAvailability): string {
  return item.label.replace('（', ' · ').replace('）', '')
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

function isTerminalTask(task: TaskSnapshot): boolean {
  return task.status === 'success' || task.status === 'fail' || task.status === 'stopped'
}

function coverProxyUrl(cover: string): string {
  return `/api/cover?url=${encodeURIComponent(cover)}`
}

function taskFileUrl(id: string): string {
  return `/api/tasks/${encodeURIComponent(id)}/file`
}

function App() {
  const [activePlatform, setActivePlatform] = useState<Platform>('全部')
  const [activeView, setActiveView] = useState<WorkspaceView>('new')
  const [input, setInput] = useState('')
  const [parsed, setParsed] = useState<ParseResult | null>(null)
  const [genericParsed, setGenericParsed] = useState<MediaParseResult | null>(null)
  const [selectedStreamId, setSelectedStreamId] = useState<string | null>(null)
  const [selectedQuality, setSelectedQuality] = useState<number | null>(null)
  const [mode, setMode] = useState<DownloadMode>('video+audio')
  const [audioContainer, setAudioContainer] = useState<AudioContainer>('m4a')
  const [isParsing, setIsParsing] = useState(false)
  const [notice, setNotice] = useState<{ kind: 'info' | 'error' | 'success'; text: string } | null>(null)
  const [health, setHealth] = useState<HealthResponse | null>(null)
  const [extractor, setExtractor] = useState<ExtractorStatus | null>(null)
  const [config, setConfig] = useState<AppConfig | null>(null)
  const [draft, setDraft] = useState<AppConfigPatch>({})
  const [showSettings, setShowSettings] = useState(false)
  const [tasks, setTasks] = useState<TaskSnapshot[]>([])
  const [accounts, setAccounts] = useState<AccountSummary[]>([])
  const [accountLabel, setAccountLabel] = useState('B站账号')
  const [accountCookie, setAccountCookie] = useState('')
  const [isSavingAccount, setIsSavingAccount] = useState(false)

  useEffect(() => {
    void Promise.all([getHealth(), getConfig(), getExtractorStatus(), getAccounts()])
      .then(([healthData, configData, extractorData, accountData]) => {
        setHealth(healthData)
        setExtractor(extractorData)
        setAccounts(accountData.accounts)
        setConfig(configData)
        setDraft({
          savePath: configData.savePath,
          ytDlpPath: configData.ytDlpPath,
          defaultDownloadMode: configData.defaultDownloadMode,
          audioContainer: configData.audioContainer,
        })
        setMode(configData.defaultDownloadMode)
        setAudioContainer(configData.audioContainer)
      })
      .catch(() => {
        setNotice({ kind: 'info', text: '本地核心尚未连接。可以先浏览界面，启动服务后即可解析链接。' })
      })
  }, [])

  useEffect(() => {
    let active = true
    const refresh = () => {
      void getTasks().then((next) => { if (active) setTasks(next) }).catch(() => {})
    }
    refresh()
    let timer: number | undefined
    const startPolling = () => {
      if (timer === undefined) timer = window.setInterval(refresh, 1_500)
    }
    let socket: WebSocket | undefined
    const canUseWebSocket = ['http:', 'https:'].includes(window.location.protocol)
    if (canUseWebSocket) {
      try {
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
        socket = new WebSocket(`${protocol}//${window.location.host}/api/ws`)
        socket.onopen = () => {
          if (timer !== undefined) {
            window.clearInterval(timer)
            timer = undefined
          }
        }
        socket.onmessage = (event) => {
          try {
            const message = JSON.parse(event.data as string) as { type?: string; task?: TaskSnapshot; id?: string }
            if (message.type === 'task-update' && message.task !== undefined) {
              setTasks((current) => [message.task as TaskSnapshot, ...current.filter((item) => item.id !== message.task?.id)])
            } else if (message.type === 'task-removed' && message.id !== undefined) {
              setTasks((current) => current.filter((item) => item.id !== message.id))
            }
          } catch {
            // Ignore malformed event payloads; the polling fallback will reconcile state.
          }
        }
        socket.onerror = startPolling
        socket.onclose = () => { if (active) startPolling() }
      } catch {
        startPolling()
      }
    } else {
      startPolling()
    }
    return () => {
      active = false
      if (timer !== undefined) window.clearInterval(timer)
      socket?.close()
    }
  }, [])

  const detectedPlatform = useMemo(() => (input.trim() === '' ? null : platformFromInput(input)), [input])
  const availableQualities = parsed?.qualities.filter((item) => item.available) ?? []
  const chosenQuality = availableQualities.find((item) => item.qn === selectedQuality) ?? availableQualities[0]
  const activeTasks = tasks.filter((task) => !isTerminalTask(task))
  const historyTasks = tasks.filter(isTerminalTask)
  // 下载很快完成时，队列不能变成“点击后没有反应”的空白页；保留最近任务作为可见回执。
  const queueTasks = activeTasks.length > 0 ? activeTasks : tasks.slice(0, 20)
  const viewTitle = activeView === 'new' ? '新建任务' : activeView === 'queue' ? '下载队列' : '历史记录'

  useEffect(() => {
    if (chosenQuality !== undefined && selectedQuality !== chosenQuality.qn) setSelectedQuality(chosenQuality.qn)
  }, [chosenQuality, selectedQuality])

  async function handleParse() {
    const value = input.trim()
    if (value === '') {
      setNotice({ kind: 'error', text: '先粘贴一个视频链接或平台短链。' })
      return
    }
    setIsParsing(true)
    setNotice(null)
    try {
      if (detectedPlatform === 'B站' || detectedPlatform === null) {
        const result = await parseMedia(value)
        setParsed(result)
        setGenericParsed(null)
        setSelectedStreamId(null)
        setSelectedQuality(result.qualities.find((item) => item.available)?.qn ?? null)
        setNotice({ kind: 'success', text: '解析完成，可以选择清晰度和输出方式。' })
      } else {
        const result = await parseUniversalMedia(value)
        setGenericParsed(result)
        setParsed(null)
        setSelectedStreamId((result.streams.find((stream) => stream.kind === 'video' && (stream.combined || mode === 'video')) ?? result.streams.find((stream) => stream.kind === 'video') ?? result.streams[0])?.id ?? null)
        setNotice({ kind: 'success', text: `${detectedPlatform}解析完成，已展示 extractor 返回的资源。` })
      }
    } catch (error) {
      setNotice({ kind: 'error', text: error instanceof Error ? error.message : '解析失败，请检查链接或稍后重试。' })
    } finally {
      setIsParsing(false)
    }
  }

  async function enqueue() {
    if (parsed === null && (genericParsed === null || selectedStreamId === null)) return
    try {
      const task = parsed !== null
        ? await createTask({
            platform: 'bilibili', input: parsed.input, bvid: parsed.bvid, cid: parsed.cid,
            qn: chosenQuality?.qn, mode, audioContainer, title: parsed.title,
          })
        : await createTask({
            platform: genericParsed?.platform ?? 'unknown', input: genericParsed?.input,
            streamId: selectedStreamId ?? undefined, mode, audioContainer, title: genericParsed?.title ?? '',
          })
      setTasks((current) => [task, ...current.filter((item) => item.id !== task.id)])
      setActiveView('queue')
      setNotice({ kind: 'success', text: '任务已加入队列，下载状态会自动更新。' })
    } catch (error) {
      setNotice({ kind: 'error', text: error instanceof Error ? error.message : '任务创建失败。' })
    }
  }

  async function saveSettings() {
    try {
      const next = await patchConfig(draft)
      setConfig(next)
      setMode(next.defaultDownloadMode)
      setAudioContainer(next.audioContainer)
      setShowSettings(false)
      setNotice({ kind: 'success', text: '设置已保存。' })
    } catch (error) {
      setNotice({ kind: 'error', text: error instanceof Error ? error.message : '设置保存失败。' })
    }
  }

  async function stopTask(id: string) {
    try {
      const next = await cancelTask(id)
      setTasks((current) => current.map((item) => item.id === next.id ? next : item))
    } catch (error) {
      setNotice({ kind: 'error', text: error instanceof Error ? error.message : '取消任务失败。' })
    }
  }

  async function retryDownload(id: string) {
    try {
      const next = await retryTask(id)
      setTasks((current) => [next, ...current.filter((item) => item.id !== next.id)])
      setActiveView('queue')
      setNotice({ kind: 'success', text: '任务已重新加入下载队列。' })
    } catch (error) {
      setNotice({ kind: 'error', text: error instanceof Error ? error.message : '任务重试失败。' })
    }
  }

  async function removeHistoryTask(id: string) {
    try {
      await removeTask(id)
      setTasks((current) => current.filter((item) => item.id !== id))
      setNotice({ kind: 'success', text: '历史任务已删除。' })
    } catch (error) {
      setNotice({ kind: 'error', text: error instanceof Error ? error.message : '删除历史任务失败。' })
    }
  }

  async function saveBiliAccount() {
    setIsSavingAccount(true)
    try {
      const account = await importBiliAccount(accountLabel, accountCookie)
      setAccounts((current) => [account, ...current.filter((item) => item.id !== account.id).map((item) => ({ ...item, active: false }))])
      setAccountCookie('')
      setNotice({ kind: 'success', text: `B站账号「${account.displayName || account.label}」已验证并启用。` })
    } catch (error) {
      setNotice({ kind: 'error', text: error instanceof Error ? error.message : 'B站账号导入失败。' })
    } finally {
      setIsSavingAccount(false)
    }
  }

  async function activateBiliAccount(id: string) {
    try {
      const account = await activateAccount(id)
      setAccounts((current) => current.map((item) => ({ ...item, active: item.id === id, ...(item.id === id ? account : {}) })))
      setNotice({ kind: 'success', text: `已切换到「${account.displayName || account.label}」。` })
    } catch (error) {
      setNotice({ kind: 'error', text: error instanceof Error ? error.message : '切换账号失败。' })
    }
  }

  async function verifyBiliAccount(id: string) {
    try {
      const account = await verifyAccount(id)
      setAccounts((current) => current.map((item) => item.id === id ? account : item))
      setNotice({ kind: 'success', text: `「${account.displayName || account.label}」登录状态有效。` })
    } catch (error) {
      setNotice({ kind: 'error', text: error instanceof Error ? error.message : '账号验证失败。' })
    }
  }

  async function deleteBiliAccount(id: string) {
    try {
      await removeAccount(id)
      setAccounts((current) => current.filter((item) => item.id !== id))
      setNotice({ kind: 'success', text: '账号及其本地凭据已删除。' })
    } catch (error) {
      setNotice({ kind: 'error', text: error instanceof Error ? error.message : '删除账号失败。' })
    }
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand-lockup">
          <div className="brand-mark"><img src={logoUrl} alt="MediaGrab" /></div>
          <div className="brand-name"><strong>MediaGrab</strong><span>MEDIA WORKSPACE</span></div>
        </div>

        <div className="sidebar-label">工作区</div>
        <nav className="side-nav" aria-label="主导航">
          <button className={`nav-item ${activeView === 'new' ? 'active' : ''}`} type="button" onClick={() => setActiveView('new')}><Plus /><span>新建任务</span></button>
          <button className={`nav-item ${activeView === 'queue' ? 'active' : ''}`} type="button" onClick={() => setActiveView('queue')}><ListChecks /><span>下载队列</span><em>{queueTasks.length}</em></button>
          <button className={`nav-item ${activeView === 'history' ? 'active' : ''}`} type="button" onClick={() => setActiveView('history')}><Clock3 /><span>历史记录</span></button>
        </nav>

        <div className="sidebar-label sources-label">平台来源</div>
        <nav className="source-nav" aria-label="平台筛选">
          {platformOptions.slice(1).map((platform) => (
            <button key={platform.label} type="button" className={`source-item ${platform.tone} ${activePlatform === platform.label ? 'selected' : ''}`} onClick={() => setActivePlatform(platform.label)}>
              <span className="source-mark">{platform.label === 'B站' ? 'B' : platform.label === '抖音' ? '♪' : '红'}</span>
              <span>{platform.label}</span>
              <span className={`source-state ${platform.label === 'B站' || extractor?.available ? 'ready' : ''}`} />
            </button>
          ))}
          <div className="source-note">更多来源持续接入</div>
        </nav>

        <div className="sidebar-bottom">
          <div className="runtime-card">
            <div className="runtime-heading"><span className={`status-dot ${health === null ? 'muted-dot' : ''}`} />本地核心</div>
            <p>{health === null ? '等待连接' : `运行中 · ${health.runtime.platform}`}</p>
            <span className={extractor?.available ? 'extractor-ready' : 'extractor-missing'}>{extractor === null ? '检查 extractor…' : extractor.available ? `yt-dlp ${extractor.version}` : 'yt-dlp 未安装'}</span>
          </div>
          <button className="settings-link" type="button" onClick={() => setShowSettings(true)}><Settings2 /><span>设置</span></button>
        </div>
      </aside>

      <main className={`main-content ${activeView !== 'new' ? 'list-view' : ''}`}>
        <header className="topbar">
          <div className="breadcrumb"><span>工作区</span><span className="crumb-slash">/</span><strong>{viewTitle}</strong></div>
          <div className="topbar-actions">
            <button className="icon-button" type="button" title="搜索任务"><Search /></button>
            <button className="avatar-button" type="button" title="设置" onClick={() => setShowSettings(true)}><img src={logoUrl} alt="" /></button>
          </div>
        </header>

        {activeView === 'new' && <section className="hero-panel">
          <div className="hero-heading">
            <div>
              <div className="hero-kicker"><span className="kicker-line" /> MEDIA INTAKE</div>
              <h1>把喜欢的内容，<span>带回本地。</span></h1>
              <p>粘贴视频或分享链接，MediaGrab 为你整理可用的媒体资源。</p>
            </div>
            <div className="hero-art" aria-hidden="true"><div className="art-ring ring-one" /><div className="art-ring ring-two" /><div className="art-core"><ArrowDownToLine /></div></div>
          </div>
          <div className="input-row">
            <div className="url-input-wrap">
              <Link2 className="input-link-icon" />
              <input
                value={input}
                onChange={(event) => setInput(event.target.value)}
                onKeyDown={(event) => { if (event.key === 'Enter') void handleParse() }}
                placeholder="粘贴 B站、抖音或小红书链接"
                aria-label="媒体链接"
              />
              {detectedPlatform !== null && <span className={`detected-badge ${detectedPlatform === 'B站' ? 'bili' : detectedPlatform === '抖音' ? 'douyin' : 'rednote'}`}>{detectedPlatform}</span>}
            </div>
            <button className="primary-button" type="button" onClick={() => void handleParse()} disabled={isParsing}>
              {isParsing ? <LoaderCircle className="spin" /> : <Plus />}
              <span>{isParsing ? '正在解析' : '解析链接'}</span>
              {!isParsing && <ArrowRight className="button-trailing" />}
            </button>
          </div>
          {notice !== null && <div className={`notice ${notice.kind}`} role="status"><span>{notice.kind === 'error' ? <X /> : notice.kind === 'success' ? <Check /> : <Activity />}</span>{notice.text}</div>}
        </section>}

        {activeView === 'new' && <div className="workspace-grid">
          <section className="panel result-panel">
            <div className="panel-heading">
              <div className="heading-title"><span className="heading-icon"><FileVideo2 /></span><div><h2>媒体预览</h2><p>{parsed === null && genericParsed === null ? '解析结果将在此显示' : '选择要保存的资源'}</p></div></div>
              {(parsed !== null || genericParsed !== null) && <span className="recognized-pill"><span className="status-dot" />{parsed !== null ? platformFromInput(parsed.input) : genericParsed?.platform}</span>}
            </div>
            {parsed === null && genericParsed === null ? (
              <div className="result-empty">
                <div className="empty-graphic"><div className="empty-play"><ArrowDownToLine /></div><span className="empty-spark spark-a" /><span className="empty-spark spark-b" /></div>
                <strong>等待一个链接</strong>
                <p>支持 B站、抖音与小红书分享链接</p>
              </div>
            ) : parsed !== null ? (
              <div className="media-result">
                <div className="media-cover">
                  {parsed.cover ? <><div className="cover-fallback"><FileVideo2 /></div><img src={coverProxyUrl(parsed.cover)} alt="" onError={(event) => event.currentTarget.remove()} /></> : <div className="cover-fallback"><FileVideo2 /></div>}
                  <span className="cover-duration">{formatDuration(parsed.durationSec)}</span>
                </div>
                <div className="media-details">
                  <div className="media-meta"><span className="mini-platform">{platformFromInput(parsed.input)}</span><span className="media-id">{parsed.bvid}</span></div>
                  <h3 title={parsed.title}>{parsed.title}</h3>
                  <p className="creator">{parsed.ownerName || '未知创作者'} <span>·</span> {parsed.pages.length} 个分段</p>
                  <div className="quality-list">
                    <div className="resource-label">可用清晰度 <span>实际可获取</span></div>
                    <div className="quality-options">
                      {parsed.qualities.filter((item) => item.available).slice(0, 4).map((item) => <button key={item.qn} type="button" className={`quality-option ${item.qn === selectedQuality ? 'selected' : ''}`} onClick={() => setSelectedQuality(item.qn)}>{qualityLabel(item)}</button>)}
                    </div>
                  </div>
                </div>
              </div>
            ) : genericParsed !== null ? (
              <div className="media-result">
                <div className="media-cover">
                  {genericParsed.cover ? <><div className="cover-fallback"><FileVideo2 /></div><img src={coverProxyUrl(genericParsed.cover)} alt="" onError={(event) => event.currentTarget.remove()} /></> : <div className="cover-fallback"><FileVideo2 /></div>}
                  <span className="cover-duration">{formatDuration(genericParsed.durationSec)}</span>
                </div>
                <div className="media-details">
                  <div className="media-meta"><span className={`mini-platform ${genericParsed.platform}`}>{genericParsed.platform}</span><span className="media-id">{genericParsed.id}</span></div>
                  <h3 title={genericParsed.title}>{genericParsed.title || '未命名媒体'}</h3>
                  <p className="creator">{genericParsed.authorName || '未知创作者'} <span>·</span> {genericParsed.streams.length} 种资源</p>
                  <div className="quality-list">
                    <div className="resource-label">资源格式 <span>选择一个</span></div>
                    <div className="stream-options">
                      {genericParsed.streams.slice(0, 3).map((stream) => <button key={stream.id} type="button" className={`stream-option ${selectedStreamId === stream.id ? 'selected' : ''}`} onClick={() => setSelectedStreamId(stream.id)}><span className="stream-kind">{stream.kind === 'audio' ? <Music2 /> : <FileVideo2 />}</span><span className="stream-copy"><strong>{stream.kind === 'video' ? stream.label || '视频' : `音频 ${stream.label || ''}`}</strong><small>{stream.codecs || stream.mimeType || '媒体流'}</small></span>{selectedStreamId === stream.id && <Check className="stream-check" />}</button>)}
                    </div>
                  </div>
                </div>
              </div>
            ) : null}
          </section>

          <div className="right-stack">
            <section className="panel output-panel">
              <div className="panel-heading compact-heading">
                <div className="heading-title"><span className="heading-icon"><FolderDown /></span><div><h2>保存设置</h2><p>配置文件输出方式</p></div></div>
              </div>
              <div className="mode-list">
                {modeOptions.map((option) => <button key={option.value} type="button" className={`mode-option ${mode === option.value ? 'selected' : ''}`} onClick={() => setMode(option.value)}><span className="mode-radio" /><span className="mode-copy"><strong>{option.label}</strong><small>{option.detail}</small></span><span className="mode-check">{mode === option.value && <Check />}</span></button>)}
              </div>
              {mode === 'audio' && <div className="audio-choice"><span>音频格式</span><div className="segmented">{(['m4a', 'mp3'] as AudioContainer[]).map((container) => <button key={container} type="button" className={audioContainer === container ? 'selected' : ''} onClick={() => setAudioContainer(container)}>{container.toUpperCase()}</button>)}</div></div>}
              <div className="save-path"><FolderDown /><span title={config?.savePath}>{config?.savePath ?? '默认下载目录'}</span><button type="button" title="设置下载目录" onClick={() => setShowSettings(true)}><Settings2 /></button></div>
              <button className="queue-button" type="button" onClick={() => void enqueue()} disabled={parsed === null && (genericParsed === null || selectedStreamId === null)}><ArrowDownToLine /><span>加入下载队列</span></button>
            </section>

            <section className="panel tasks-panel">
              <div className="panel-heading compact-heading">
                <div className="heading-title"><span className="heading-icon"><ListChecks /></span><div><h2>最近任务</h2><p>{tasks.length === 0 ? '还没有下载任务' : `${tasks.length} 个本地任务`}</p></div></div>
                <span className="task-count">{tasks.length.toString().padStart(2, '0')}</span>
              </div>
              {tasks.length === 0 ? <div className="tasks-empty"><Clock3 /><span>新任务会显示在这里</span></div> : <div className="task-list">{tasks.slice(0, 3).map((task) => <div className="task-row" key={task.id}><span className={`task-type-icon ${task.mode === 'audio' ? 'audio' : ''}`}>{task.mode === 'audio' ? <Music2 /> : <FileVideo2 />}</span><span className="task-title"><strong title={task.title || task.bvid || task.input}>{task.title || task.bvid || task.input}</strong><small>{task.platform} · {task.mode === 'audio' ? `音频 ${task.audioContainer ?? 'm4a'}` : task.mode === 'video' ? '仅视频' : '视频 + 音频'}</small></span><span className={`task-indicator ${task.status}`}>{task.status === 'success' ? <Check /> : task.status === 'fail' ? <X /> : task.status === 'waiting' ? <Clock3 /> : <LoaderCircle className="spin" />}</span>{(task.status === 'waiting' || task.status === 'downloading' || task.status === 'merging') && <button className="task-action" type="button" title="取消任务" onClick={() => void stopTask(task.id)}><X /></button>}{isTerminalTask(task) && <button className="task-action" type="button" title="删除任务" onClick={() => void removeHistoryTask(task.id)}><Trash2 /></button>}</div>)}</div>}
            </section>
          </div>
        </div>}

        {activeView !== 'new' && <section className="panel task-view-panel">
          <div className="panel-heading">
            <div className="heading-title"><span className="heading-icon">{activeView === 'queue' ? <ListChecks /> : <Clock3 />}</span><div><h2>{viewTitle}</h2><p>{activeView === 'queue' ? '正在等待或处理的本地任务' : '已完成、失败或停止的任务'}</p></div></div>
            <span className="task-count">{(activeView === 'queue' ? queueTasks : historyTasks).length.toString().padStart(2, '0')}</span>
          </div>
          {(activeView === 'queue' ? queueTasks : historyTasks).length === 0 ? <div className="task-view-empty"><Clock3 /><strong>{activeView === 'queue' ? '当前没有下载任务' : '还没有历史任务'}</strong><span>{activeView === 'queue' ? '从新建任务解析内容后加入下载队列。' : '完成或停止的下载会显示在这里。'}</span></div> : <div className="task-view-list">{(activeView === 'queue' ? queueTasks : historyTasks).map((task) => <div className="task-view-row" key={task.id}><span className={`task-type-icon ${task.mode === 'audio' ? 'audio' : ''}`}>{task.mode === 'audio' ? <Music2 /> : <FileVideo2 />}</span><span className="task-title"><strong title={task.title || task.bvid || task.input}>{task.title || task.bvid || task.input}</strong><small>{task.platform} · {task.mode === 'audio' ? `音频 ${task.audioContainer ?? 'm4a'}` : task.mode === 'video' ? '仅视频' : '视频 + 音频'} · {taskStatusLabel(task.status)}{task.status === 'success' ? ` · ${task.fileName}` : ''}</small></span><span className={`task-indicator ${task.status}`}>{task.status === 'success' ? <Check /> : task.status === 'fail' ? <X /> : task.status === 'stopped' ? <X /> : task.status === 'waiting' ? <Clock3 /> : <LoaderCircle className="spin" />}</span>{task.status === 'success' && <a className="task-action" title="下载文件" href={taskFileUrl(task.id)} download><ArrowDownToLine /></a>}{!isTerminalTask(task) && <button className="task-action" type="button" title="取消任务" onClick={() => void stopTask(task.id)}><X /></button>}{isTerminalTask(task) && task.status !== 'success' && <button className="task-action" type="button" title="重试任务" onClick={() => void retryDownload(task.id)}><RotateCcw /></button>}{isTerminalTask(task) && <button className="task-action" type="button" title="删除任务" onClick={() => void removeHistoryTask(task.id)}><Trash2 /></button>}</div>)}</div>}
        </section>}
      </main>

      {showSettings && <div className="modal-backdrop" role="presentation" onClick={() => setShowSettings(false)}><section className="settings-modal" role="dialog" aria-modal="true" aria-labelledby="settings-title" onClick={(event) => event.stopPropagation()}><div className="modal-heading"><div><p className="eyebrow">PREFERENCES</p><h2 id="settings-title">应用设置</h2></div><button className="icon-button" type="button" title="关闭" onClick={() => setShowSettings(false)}><X /></button></div><label className="field-label">下载目录<input value={draft.savePath ?? ''} onChange={(event) => setDraft((current) => ({ ...current, savePath: event.target.value }))} /></label><label className="field-label">yt-dlp 路径 <span>留空表示使用 PATH</span><input placeholder="yt-dlp" value={draft.ytDlpPath ?? ''} onChange={(event) => setDraft((current) => ({ ...current, ytDlpPath: event.target.value }))} /></label><label className="field-label">默认输出<select value={draft.defaultDownloadMode ?? 'video+audio'} onChange={(event) => setDraft((current) => ({ ...current, defaultDownloadMode: event.target.value as DownloadMode }))}>{modeOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label><div className="account-section"><div className="account-section-heading"><div><p className="eyebrow">ACCOUNTS</p><h3><UserRound /> B站账号</h3></div><span>凭据仅保存在本机</span></div><p className="account-hint">导入浏览器复制的 Cookie 后，可获取账号实际有权限的清晰度。不会上传到远程服务，也不会在页面回显。</p>{accounts.length > 0 && <div className="account-list">{accounts.map((account) => <div className={`account-row ${account.active ? 'active' : ''}`} key={account.id}><span className="account-avatar"><UserRound /></span><span className="account-copy"><strong>{account.displayName || account.label}</strong><small>{account.active ? '当前使用' : account.status === 'active' ? '已验证' : '需要重新登录'}{account.vip ? ' · 大会员' : ''}</small></span>{!account.active && <button className="account-action" type="button" title="切换账号" onClick={() => void activateBiliAccount(account.id)}><ShieldCheck /></button>}<button className="account-action" type="button" title="验证账号" onClick={() => void verifyBiliAccount(account.id)}><Check /></button><button className="account-action danger" type="button" title="删除账号" onClick={() => void deleteBiliAccount(account.id)}><Trash2 /></button></div>)}</div>}<label className="field-label">账号名称<input value={accountLabel} onChange={(event) => setAccountLabel(event.target.value)} /></label><label className="field-label">Cookie <span>只保存在本机核心，不会显示在任务或日志中</span><textarea className="account-cookie-input" value={accountCookie} onChange={(event) => setAccountCookie(event.target.value)} placeholder="粘贴 B站 Cookie，例如包含 SESSDATA=..." /></label><button className="account-import-button" type="button" onClick={() => void saveBiliAccount()} disabled={isSavingAccount || accountCookie.trim() === ''}>{isSavingAccount ? <LoaderCircle className="spin" /> : <ShieldCheck />}<span>{isSavingAccount ? '正在验证' : '导入并验证 B站账号'}</span></button></div><div className="modal-footer"><span>MediaGrab</span><button className="primary-button" type="button" onClick={() => void saveSettings()}><Check /><span>保存设置</span></button></div></section></div>}
    </div>
  )
}

export default App
