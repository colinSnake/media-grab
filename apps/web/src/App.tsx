import { useEffect, useLayoutEffect, useMemo, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import { getCurrentWindow } from '@tauri-apps/api/window'
import {
  Activity,
  ArrowDownToLine,
  ArrowRight,
  Check,
  Clock3,
  FolderDown,
  Link2,
  ListChecks,
  LoaderCircle,
  Monitor,
  Moon,
  Music2,
  Plus,
  Search,
  Server,
  Settings2,
  Sun,
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
  TaskSnapshot,
} from '@mediagrab/shared'
import { taskDedupeKey } from '@mediagrab/shared'
import { activateAccount, cancelTask, createTask, getAccounts, getConfig, getExtractorStatus, getHealth, getTasks, importBiliAccount, parseMedia, parseUniversalMedia, patchConfig, removeAccount, removeTask, retryTask, verifyAccount, type HealthResponse, type ExtractorStatus } from './api'
import logoUrl from './assets/mediagrab-logo.svg'
import { TaskRow } from './components/TaskRow'
import { TaskSearchDialog } from './components/TaskSearchDialog'
import { isTerminalTask } from './components/TaskRow'
import { SettingsModal } from './components/SettingsModal'
import { MediaPreview } from './components/MediaPreview'
import { modeOptions } from './lib/options'

type Platform = '全部' | 'B站' | '抖音' | '小红书'
type AccountPlatform = 'bilibili' | 'douyin' | 'xiaohongshu'
type WorkspaceView = 'new' | 'queue' | 'history'
type ThemeMode = 'system' | 'light' | 'dark'

const THEME_STORAGE_KEY = 'mediagrab-theme'
const themeModes: ThemeMode[] = ['system', 'dark', 'light']
const themeLabels: Record<ThemeMode, string> = {
  system: '跟随系统',
  light: '浅色主题',
  dark: '深色主题',
}

function coreStatusTooltip(health: HealthResponse | null, extractor: ExtractorStatus | null): string {
  if (health === null) return '本地核心 · 连接失败'
  const extractorStatus = extractor === null
    ? '正在检查 yt-dlp'
    : extractor.available
      ? `yt-dlp ${extractor.version}`
      : 'yt-dlp 未安装'
  return `本地核心 · 连接正常\n${health.runtime.platform} · ${extractorStatus}`
}

function readThemeMode(): ThemeMode {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY)
    if (stored === 'system' || stored === 'light' || stored === 'dark') return stored
  } catch {
    // Restricted webviews may not expose localStorage.
  }
  return 'system'
}

function isTauriDesktop(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

const platformOptions: { label: Platform; tone: string; hint: string }[] = [
  { label: '全部', tone: 'all', hint: '所有来源' },
  { label: 'B站', tone: 'bili', hint: 'bilibili.com' },
  { label: '抖音', tone: 'douyin', hint: 'douyin.com' },
  { label: '小红书', tone: 'rednote', hint: 'xiaohongshu.com' },
]

function platformFromInput(input: string): Exclude<Platform, '全部'> {
  const normalized = input.toLowerCase()
  if (normalized.includes('douyin') || normalized.includes('iesdouyin')) return '抖音'
  if (normalized.includes('xiaohongshu') || normalized.includes('xhslink')) return '小红书'
  return 'B站'
}

function uniqueTaskList(items: TaskSnapshot[]): TaskSnapshot[] {
  const seen = new Set<string>()
  return items.filter((task) => {
    const key = taskDedupeKey(task)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function App() {
  const [themeMode, setThemeMode] = useState<ThemeMode>(readThemeMode)
  const [activePlatform, setActivePlatform] = useState<Platform>('全部')
  const [activeView, setActiveView] = useState<WorkspaceView>('new')
  const [input, setInput] = useState('')
  const [parsed, setParsed] = useState<ParseResult | null>(null)
  const [genericParsed, setGenericParsed] = useState<MediaParseResult | null>(null)
  const [selectedStreamId, setSelectedStreamId] = useState<string | null>(null)
  const [selectedQuality, setSelectedQuality] = useState<number | null>(null)
  const [mode, setMode] = useState<DownloadMode>('video+audio')
  const [audioContainer, setAudioContainer] = useState<AudioContainer>('mp3')
  const [isParsing, setIsParsing] = useState(false)
  const [notice, setNotice] = useState<{ kind: 'info' | 'error' | 'success'; text: string } | null>(null)
  const [health, setHealth] = useState<HealthResponse | null>(null)
  const [extractor, setExtractor] = useState<ExtractorStatus | null>(null)
  const [config, setConfig] = useState<AppConfig | null>(null)
  const [draft, setDraft] = useState<AppConfigPatch>({})
  const [showSettings, setShowSettings] = useState(false)
  const [showTaskSearch, setShowTaskSearch] = useState(false)
  const [tasks, setTasks] = useState<TaskSnapshot[]>([])
  const [accounts, setAccounts] = useState<AccountSummary[]>([])
  const [activeAccountPlatform, setActiveAccountPlatform] = useState<AccountPlatform>('bilibili')
  const [accountCookie, setAccountCookie] = useState('')
  const [isSavingAccount, setIsSavingAccount] = useState(false)

  useLayoutEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const applyTheme = () => {
      const resolvedTheme = themeMode === 'system' ? (media.matches ? 'dark' : 'light') : themeMode
      document.documentElement.dataset.theme = resolvedTheme
      document.documentElement.style.colorScheme = resolvedTheme
      const themeColor = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim()
      document.querySelector('meta[name="theme-color"]')?.setAttribute('content', themeColor)
    }
    applyTheme()
    media.addEventListener('change', applyTheme)
    return () => media.removeEventListener('change', applyTheme)
  }, [themeMode])

  useEffect(() => {
    try {
      localStorage.setItem(THEME_STORAGE_KEY, themeMode)
    } catch {
      // Keep the current session usable when storage is unavailable.
    }
  }, [themeMode])

  const themeIcon = themeMode === 'system' ? <Monitor /> : themeMode === 'light' ? <Sun /> : <Moon />
  const nextThemeMode = themeModes[(themeModes.indexOf(themeMode) + 1) % themeModes.length] ?? 'system'
  const themeTooltip = themeLabels[themeMode]

  function handleWindowDragPointerDown(event: ReactPointerEvent<HTMLElement>) {
    if (event.button !== 0 || !isTauriDesktop()) return
    const target = event.target as HTMLElement
    if (target.closest('button, a, input, select, textarea, [role="button"]') !== null) return
    void getCurrentWindow().startDragging().catch(() => {})
  }

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
          douyinCookieBrowser: configData.douyinCookieBrowser,
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
      void getTasks().then((next) => { if (active) setTasks(uniqueTaskList(next)) }).catch(() => {})
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
              setTasks((current) => uniqueTaskList([message.task as TaskSnapshot, ...current.filter((item) => item.id !== message.task?.id)]))
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
  const queueTasks = activeTasks
  const recentTasks = tasks.slice(0, 3)
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

  async function handlePageChange(page: number) {
    if (parsed === null || page === parsed.page) return
    setIsParsing(true)
    setNotice(null)
    try {
      const result = await parseMedia(parsed.input, page)
      setParsed(result)
      setSelectedQuality(result.qualities.find((item) => item.available)?.qn ?? null)
      setNotice({ kind: 'success', text: `已切换到 P${result.page}，资源信息已更新。` })
    } catch (error) {
      setNotice({ kind: 'error', text: error instanceof Error ? error.message : '分 P 解析失败，请稍后重试。' })
    } finally {
      setIsParsing(false)
    }
  }

  async function enqueue() {
    if (parsed === null && (genericParsed === null || selectedStreamId === null)) return
    try {
      const selectedGenericStream = genericParsed?.streams.find((stream) => stream.id === selectedStreamId)
      const result = parsed !== null
        ? await createTask({
            platform: 'bilibili', input: parsed.input, bvid: parsed.bvid, cid: parsed.cid,
            qn: chosenQuality?.qn, qualityLabel: chosenQuality?.label, mode, audioContainer, title: parsed.title,
          })
        : await createTask({
            platform: genericParsed?.platform ?? 'unknown', input: genericParsed?.input,
            streamId: selectedStreamId ?? undefined,
            qualityLabel: selectedGenericStream === undefined
              ? undefined
              : selectedGenericStream.label || (selectedGenericStream.width !== undefined && selectedGenericStream.height !== undefined
                ? `${selectedGenericStream.width}×${selectedGenericStream.height}`
                : selectedGenericStream.codecs || selectedGenericStream.mimeType || (selectedGenericStream.kind === 'audio' ? '音频资源' : '视频资源')),
            mode, audioContainer, title: genericParsed?.title ?? '',
          })
      const task = result.task
      setTasks((current) => uniqueTaskList([task, ...current.filter((item) => item.id !== task.id)]))
      setInput('')
      setParsed(null)
      setGenericParsed(null)
      setSelectedStreamId(null)
      setSelectedQuality(null)
      setActiveView(result.deduplicated && isTerminalTask(task) ? 'history' : 'queue')
      setNotice(result.deduplicated
        ? { kind: 'info', text: isTerminalTask(task) ? '相同下载配置已存在，已保留历史记录中的任务。' : '相同下载配置已在队列中，未重复创建任务。' }
        : null)
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
      setTasks((current) => uniqueTaskList([next, ...current.filter((item) => item.id !== next.id)]))
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
      const account = await importBiliAccount(accountCookie)
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
        <div className="sidebar-window-drag-region" data-tauri-drag-region onPointerDown={handleWindowDragPointerDown} aria-hidden="true" />
        <div className="brand-lockup">
          <div className="brand-mark"><img src={logoUrl} alt="MediaGrab" /></div>
          <div className="brand-name"><strong>MediaGrab</strong><span>让内容回到本地</span></div>
        </div>

        <div className="sidebar-label">工作区</div>
        <nav className="side-nav" aria-label="主导航">
          <button className={`nav-item ${activeView === 'new' ? 'active' : ''}`} type="button" onClick={() => setActiveView('new')}><Plus /><span>新建任务</span></button>
          <button className={`nav-item ${activeView === 'queue' ? 'active' : ''}`} type="button" onClick={() => setActiveView('queue')}><ListChecks /><span>下载队列</span><em className="nav-count" aria-label={`${queueTasks.length} 个排队任务`}>{queueTasks.length}</em></button>
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
          <button className="settings-link" type="button" onClick={() => setShowSettings(true)}><Settings2 /><span>设置</span></button>
        </div>
      </aside>

      <main className={`main-content ${activeView !== 'new' ? 'list-view' : ''}`}>
        <header className="topbar" data-tauri-drag-region onPointerDown={handleWindowDragPointerDown}>
          <div className="topbar-actions">
            <button className="icon-button" type="button" title="搜索任务" aria-label="搜索任务" onClick={() => setShowTaskSearch(true)}><Search /></button>
            <button
              className="icon-button theme-toggle"
              type="button"
              data-tooltip={themeTooltip}
              aria-label={themeTooltip}
              onClick={() => setThemeMode(nextThemeMode)}
            >
              {themeIcon}
            </button>
            <span
              className={`core-status tooltip-target ${health === null ? 'error' : 'ready'}`}
              data-tooltip={coreStatusTooltip(health, extractor)}
              aria-label={coreStatusTooltip(health, extractor)}
              role="status"
              tabIndex={0}
            >
              <Server />
              <span className="core-status-dot" />
            </span>
          </div>
        </header>

        {activeView !== 'new' && notice !== null && <div className={`notice global-notice ${notice.kind}`} role="status"><span>{notice.kind === 'error' ? <X /> : notice.kind === 'success' ? <Check /> : <Activity />}</span>{notice.text}</div>}

        {activeView === 'new' && <section className="hero-panel">
          <div className="hero-heading">
            <div>
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
          <MediaPreview parsed={parsed} genericParsed={genericParsed} selectedQuality={selectedQuality} selectedStreamId={selectedStreamId} onSelectQuality={setSelectedQuality} onSelectStream={setSelectedStreamId} onSelectPage={(page) => void handlePageChange(page)} />

          <div className="right-stack">
            <section className="panel output-panel">
              <div className="panel-heading compact-heading">
                <div className="heading-title"><span className="heading-icon"><FolderDown /></span><div><h2>保存设置</h2></div></div>
              </div>
              <div className="mode-list">
                {modeOptions.map((option) => (
                  <div key={option.value} className={`mode-option ${mode === option.value ? 'selected' : ''}`}>
                    <button className="mode-choice" type="button" aria-pressed={mode === option.value} onClick={() => setMode(option.value)}>
                      <span className="mode-radio" />
                      <span className="mode-copy"><strong>{option.label}</strong>{option.detail !== '' && <small>{option.detail}</small>}</span>
                    </button>
                    {option.value === 'audio' && mode === 'audio' && <span className="segmented" role="group" aria-label="音频格式">
                      {(['m4a', 'mp3'] as AudioContainer[]).map((container) => <button key={container} type="button" aria-pressed={audioContainer === container} className={audioContainer === container ? 'selected' : ''} onClick={() => { setMode('audio'); setAudioContainer(container) }}>{container.toUpperCase()}</button>)}
                    </span>}
                    <span className="mode-check">{mode === option.value && <Check />}</span>
                  </div>
                ))}
              </div>
              <button className="queue-button" type="button" onClick={() => void enqueue()} disabled={parsed === null && (genericParsed === null || selectedStreamId === null)}><ArrowDownToLine /><span>加入下载队列</span></button>
            </section>

            <section className="panel tasks-panel">
              <div className="panel-heading compact-heading">
                <div className="heading-title"><span className="heading-icon"><ListChecks /></span><div><h2>最近任务</h2></div></div>
                <span className="task-count" aria-label={`${tasks.length} 项任务`}><strong>{tasks.length}</strong><small>项</small></span>
              </div>
              {recentTasks.length === 0 ? <div className="tasks-empty"><Clock3 /><span>新任务会显示在这里</span></div> : <div className="task-list">{recentTasks.map((task) => <TaskRow key={task.id} task={task} variant="compact" onCancel={(id) => void stopTask(id)} onRemove={(id) => void removeHistoryTask(id)} />)}</div>}
            </section>
          </div>
        </div>}

        {activeView !== 'new' && <section className="panel task-view-panel">
          <div className="panel-heading">
            <div className="heading-title"><span className="heading-icon">{activeView === 'queue' ? <ListChecks /> : <Clock3 />}</span><div><h2>{viewTitle}</h2></div></div>
            <span className="task-count" aria-label={`${(activeView === 'queue' ? queueTasks : historyTasks).length} 项任务`}><strong>{(activeView === 'queue' ? queueTasks : historyTasks).length}</strong><small>项</small></span>
          </div>
          {(activeView === 'queue' ? queueTasks : historyTasks).length === 0 ? <div className="task-view-empty"><Clock3 /><strong>{activeView === 'queue' ? '当前没有下载任务' : '还没有历史任务'}</strong><span>{activeView === 'queue' ? '从新建任务解析内容后加入下载队列。' : '完成、失败或停止的下载会显示在这里。'}</span></div> : <div className="task-view-list">{(activeView === 'queue' ? queueTasks : historyTasks).map((task) => <TaskRow key={task.id} task={task} onCancel={(id) => void stopTask(id)} onRetry={(id) => void retryDownload(id)} onRemove={(id) => void removeHistoryTask(id)} />)}</div>}
        </section>}
      </main>

      <TaskSearchDialog
        open={showTaskSearch}
        tasks={tasks}
        onClose={() => setShowTaskSearch(false)}
        onSelect={(task) => { setActiveView(isTerminalTask(task) ? 'history' : 'queue'); setShowTaskSearch(false) }}
      />

      <SettingsModal
        open={showSettings}
        draft={draft}
        onDraftChange={(patch) => setDraft((current) => ({ ...current, ...patch }))}
        accounts={accounts}
        activeAccountPlatform={activeAccountPlatform}
        onAccountPlatformChange={setActiveAccountPlatform}
        accountCookie={accountCookie}
        isSavingAccount={isSavingAccount}
        onAccountCookieChange={setAccountCookie}
        onSave={() => void saveSettings()}
        onClose={() => setShowSettings(false)}
        onSaveAccount={() => void saveBiliAccount()}
        onActivateAccount={(id) => void activateBiliAccount(id)}
        onVerifyAccount={(id) => void verifyBiliAccount(id)}
        onDeleteAccount={(id) => void deleteBiliAccount(id)}
      />
    </div>
  )
}

export default App
