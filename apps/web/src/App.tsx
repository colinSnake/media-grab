import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import { createPortal } from 'react-dom'
import { getCurrentWindow } from '@tauri-apps/api/window'
import {
  Activity,
  ArrowDownToLine,
  ArrowRight,
  Check,
  Clock3,
  ChevronDown,
  FolderDown,
  Globe2,
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
  AccountPlatform,
  AppConfig,
  AppConfigPatch,
  AudioContainer,
  CookieAccountPlatform,
  DownloadMode,
  MediaParseResult,
  ParseResult,
  Platform,
  TaskSnapshot,
} from '@mediagrab/shared'
import { detectPlatform, platformCatalog, platformLabel, taskDedupeKey } from '@mediagrab/shared'
import { activateAccount, cancelTask, clearCookie, createTask, getAccounts, getConfig, getCookieStatus, getExtractorStatus, getHealth, getTaskEventConnection, getTasks, importBiliAccount, parseMedia, parseUniversalMedia, patchConfig, removeAccount, removeTask, retryTask, saveCookie, verifyAccount, type HealthResponse, type ExtractorStatus } from './api'
import logoUrl from './assets/mediagrab-logo-small.svg'
import { TaskRow, type DownloadResult } from './components/TaskRow'
import { TaskSearchDialog } from './components/TaskSearchDialog'
import { isTerminalTask } from './components/TaskRow'
import { SettingsModal } from './components/SettingsModal'
import { MediaPreview } from './components/MediaPreview'
import { PlatformLogo } from './components/PlatformLogo'
import { modeOptions } from './lib/options'
import { chooseDownloadDirectory, notifyDownloadFinished } from './native'

type HistoryPlatformFilter = Platform | 'all'
type SettingsAccountPlatform = AccountPlatform | 'youtube'
type CookieAccountState = { cookie: string; configured: boolean; saving: boolean }
type WorkspaceView = 'new' | 'queue' | 'history'
type ThemeMode = 'system' | 'light' | 'dark'
type CoreConnection = 'connecting' | 'ready' | 'disconnected'

const THEME_STORAGE_KEY = 'mediagrab-theme'
const themeModes: ThemeMode[] = ['system', 'dark', 'light']
const themeLabels: Record<ThemeMode, string> = {
  system: '跟随系统',
  light: '浅色主题',
  dark: '深色主题',
}

const sourcePlatforms = platformCatalog.filter((platform) => platform.parse)
const defaultPlatform = sourcePlatforms[0]?.platform ?? 'bilibili'
const heroTitlePrimary = '把喜欢的内容，'
const heroTitleAccent = '带回本地。'
const heroTitle = `${heroTitlePrimary}${heroTitleAccent}`

function coreStatusTooltip(connection: CoreConnection, health: HealthResponse | null, extractor: ExtractorStatus | null, retryCount: number): string {
  if (connection === 'connecting') return retryCount === 0 ? '下载服务 · 正在启动' : `下载服务 · 正在连接（第 ${retryCount} 次重试）`
  if (health === null) return `下载服务 · 未连接，正在重试（第 ${retryCount} 次）`
  const extractorStatus = extractor === null
    ? '正在检查 yt-dlp'
    : extractor.available
      ? `yt-dlp ${extractor.version}`
      : 'yt-dlp 未安装'
  return `下载服务 · 连接正常\n${health.runtime.platform} · ${extractorStatus}`
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
  const [heroTitleLength, setHeroTitleLength] = useState(0)
  const [activePlatform, setActivePlatform] = useState<Platform>(defaultPlatform)
  const [historyPlatform, setHistoryPlatform] = useState<HistoryPlatformFilter>('all')
  const [historyFilterOpen, setHistoryFilterOpen] = useState(false)
  const historyFilterRef = useRef<HTMLDivElement>(null)
  const [activeView, setActiveView] = useState<WorkspaceView>('new')
  const [input, setInput] = useState('')
  const inputElementRef = useRef<HTMLInputElement>(null)
  const [parsed, setParsed] = useState<ParseResult | null>(null)
  const [genericParsed, setGenericParsed] = useState<MediaParseResult | null>(null)
  const [selectedStreamId, setSelectedStreamId] = useState<string | null>(null)
  const [selectedQuality, setSelectedQuality] = useState<number | null>(null)
  const [mode, setMode] = useState<DownloadMode>('video+audio')
  const [audioContainer, setAudioContainer] = useState<AudioContainer>('mp3')
  const [isParsing, setIsParsing] = useState(false)
  const [isEnqueuing, setIsEnqueuing] = useState(false)
  const [isSavingSettings, setIsSavingSettings] = useState(false)
  const [notice, setNotice] = useState<{ kind: 'info' | 'error' | 'success'; text: string } | null>(null)
  const [showConnectionNotice, setShowConnectionNotice] = useState(true)
  const [health, setHealth] = useState<HealthResponse | null>(null)
  const [coreConnection, setCoreConnection] = useState<CoreConnection>('connecting')
  const [coreRetryCount, setCoreRetryCount] = useState(0)
  const [extractor, setExtractor] = useState<ExtractorStatus | null>(null)
  const [config, setConfig] = useState<AppConfig | null>(null)
  const [draft, setDraft] = useState<AppConfigPatch>({})
  const [showSettings, setShowSettings] = useState(false)
  const [showTaskSearch, setShowTaskSearch] = useState(false)
  const [tasks, setTasks] = useState<TaskSnapshot[]>([])
  const notifiedTaskIdsRef = useRef(new Set<string>())
  const [downloadResults, setDownloadResults] = useState<Record<string, DownloadResult>>(() => {
    try {
      const stored = localStorage.getItem('mediagrab:download-results')
      if (stored !== null) {
        const value: unknown = JSON.parse(stored)
        if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
          return Object.fromEntries(Object.entries(value).filter(([, result]) =>
            result !== null && typeof result === 'object' && 'status' in result &&
            (result.status === 'success' || result.status === 'fail'))) as Record<string, DownloadResult>
        }
      }
      const legacy: unknown = JSON.parse(localStorage.getItem('mediagrab:downloaded-tasks') ?? '[]')
      return Array.isArray(legacy) ? Object.fromEntries(legacy.filter((id): id is string => typeof id === 'string').map((id) => [id, { status: 'success' }])) : {}
    } catch { return {} }
  })
  const [accounts, setAccounts] = useState<AccountSummary[]>([])
  const [accountAction, setAccountAction] = useState<{ id: string; action: 'activate' | 'verify' | 'delete' | 'clear-cookie' } | null>(null)
  const [activeAccountPlatform, setActiveAccountPlatform] = useState<SettingsAccountPlatform>('bilibili')
  const [accountCookie, setAccountCookie] = useState('')
  const [isSavingAccount, setIsSavingAccount] = useState(false)
  const cookieAccountPlatforms: CookieAccountPlatform[] = ['douyin', 'xiaohongshu']
  const [cookieAccounts, setCookieAccounts] = useState<Record<CookieAccountPlatform, CookieAccountState>>({
    douyin: { cookie: '', configured: false, saving: false },
    xiaohongshu: { cookie: '', configured: false, saving: false },
  })
  const visibleNotice = coreConnection === 'connecting' && showConnectionNotice
    ? { kind: 'info', text: coreRetryCount === 0 ? '正在启动下载服务，请稍等…' : `正在连接下载服务，第 ${coreRetryCount} 次重试…` }
    : coreConnection === 'disconnected' && showConnectionNotice
      ? { kind: 'error', text: `下载服务暂时不可用，仍在自动重试（第 ${coreRetryCount} 次）…` }
      : notice

  useEffect(() => {
    if (coreConnection === 'ready') {
      setShowConnectionNotice(false)
      return
    }
    setShowConnectionNotice(true)
    const timeout = window.setTimeout(() => setShowConnectionNotice(false), 3_000)
    return () => window.clearTimeout(timeout)
  }, [coreConnection])

  useEffect(() => {
    try { localStorage.setItem('mediagrab:download-results', JSON.stringify(downloadResults)) } catch { /* Keep session usable. */ }
  }, [downloadResults])

  useEffect(() => {
    if (notice === null) return
    const timeout = window.setTimeout(() => setNotice((current) => current === notice ? null : current), 3_000)
    return () => window.clearTimeout(timeout)
  }, [notice])

  useEffect(() => {
    if (!historyFilterOpen) return
    const handleOutsidePointerDown = (event: PointerEvent) => {
      const target = event.target
      if (target instanceof Node && historyFilterRef.current?.contains(target)) return
      setHistoryFilterOpen(false)
    }
    document.addEventListener('pointerdown', handleOutsidePointerDown)
    return () => document.removeEventListener('pointerdown', handleOutsidePointerDown)
  }, [historyFilterOpen])

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

  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setHeroTitleLength(heroTitle.length)
      return
    }

    let current = 0
    let timer = 0
    const tick = () => {
      current = current >= heroTitle.length ? 0 : current + 1
      setHeroTitleLength(current)
      timer = window.setTimeout(tick, current === heroTitle.length ? 1800 : current === 0 ? 420 : 140)
    }
    timer = window.setTimeout(tick, 420)
    return () => window.clearTimeout(timer)
  }, [])

  useLayoutEffect(() => {
    inputElementRef.current?.scrollTo({ left: 0 })
  }, [input])

  useEffect(() => {
    if (!isTauriDesktop()) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setShowSettings(false)
        setShowTaskSearch(false)
        return
      }
      if (!(event.metaKey || event.ctrlKey) || event.altKey) return
      if (event.key.toLowerCase() === 'l') {
        event.preventDefault()
        setActiveView('new')
        requestAnimationFrame(() => inputElementRef.current?.focus())
      } else if (event.key === ',') {
        event.preventDefault()
        setShowSettings(true)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

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
    let active = true
    let checking = false
    let initialized = false
    const startedAt = Date.now()
    let requestController: AbortController | undefined

    const initialize = async () => {
      await Promise.allSettled([
        getConfig().then((configData) => {
          if (!active) return
          setConfig(configData)
          setDraft({
            savePath: configData.savePath,
            ytDlpPath: configData.ytDlpPath,
            defaultDownloadMode: configData.defaultDownloadMode,
            audioContainer: configData.audioContainer,
          })
          setMode(configData.defaultDownloadMode)
          setAudioContainer(configData.audioContainer)
        }).catch(() => { initialized = false }),
        getExtractorStatus().then((data) => { if (active) setExtractor(data) }),
        getAccounts().then((data) => { if (active) setAccounts(data.accounts) }),
        ...(['douyin', 'xiaohongshu'] as const).map((platform) => getCookieStatus(platform).then((data) => {
          if (!active) return
          setCookieAccounts((current) => ({
            ...current,
            [platform]: { ...current[platform], configured: data.configured },
          }))
        })),
      ])
    }

    const refresh = async () => {
      if (checking) return
      checking = true
      const controller = new AbortController()
      requestController = controller
      const timeout = window.setTimeout(() => controller.abort(), 5_000)
      try {
        const healthData = await getHealth(controller.signal)
        if (!active) return
        setHealth(healthData)
        setCoreConnection('ready')
        setCoreRetryCount(0)
        if (!initialized) {
          initialized = true
          void initialize()
        }
      } catch {
        if (!active) return
        setHealth(null)
        setCoreRetryCount((current) => current + 1)
        setCoreConnection(Date.now() - startedAt < 60_000 ? 'connecting' : 'disconnected')
      } finally {
        window.clearTimeout(timeout)
        checking = false
      }
    }

    void refresh()
    const timer = window.setInterval(() => void refresh(), 1_500)
    return () => {
      active = false
      requestController?.abort()
      window.clearInterval(timer)
    }
  }, [])

  useEffect(() => {
    let active = true
    let firstSnapshot = true
    const onTaskUpdate = (task: TaskSnapshot) => {
      if (task.status !== 'success' || notifiedTaskIdsRef.current.has(task.id)) return
      notifiedTaskIdsRef.current.add(task.id)
      void notifyDownloadFinished(task.title || task.fileName).catch(() => {})
    }
    const refresh = () => {
      void getTasks().then((next) => {
        if (!active) return
        if (firstSnapshot) {
          firstSnapshot = false
          for (const task of next) if (task.status === 'success') notifiedTaskIdsRef.current.add(task.id)
        } else {
          for (const task of next) onTaskUpdate(task)
        }
        setTasks(uniqueTaskList(next))
      }).catch(() => {})
    }
    refresh()
    let timer: number | undefined
    const startPolling = () => {
      if (timer === undefined) timer = window.setInterval(refresh, 1_500)
    }
    let socket: WebSocket | undefined
    void getTaskEventConnection().then(({ url, protocols }) => {
      if (!active) return
      socket = new WebSocket(url, protocols)
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
            if (!firstSnapshot) onTaskUpdate(message.task)
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
    }).catch(startPolling)
    return () => {
      active = false
      if (timer !== undefined) window.clearInterval(timer)
      socket?.close()
    }
  }, [])

  const detectedPlatform = useMemo(() => (input.trim() === '' ? null : detectPlatform(input)), [input])
  const availableQualities = parsed?.qualities.filter((item) => item.available) ?? []
  const chosenQuality = availableQualities.find((item) => item.qn === selectedQuality) ?? availableQualities[0]
  const visibleTasks = tasks.filter((task) => task.platform === activePlatform)
  const listPlatformTasks = historyPlatform === 'all' ? tasks : tasks.filter((task) => task.platform === historyPlatform)
  const historyTasks = listPlatformTasks
    .filter((task) => task.status === 'success' ? downloadResults[task.id] !== undefined : isTerminalTask(task))
  const queueTasks = listPlatformTasks.filter((task) => !isTerminalTask(task) || (task.status === 'success' && downloadResults[task.id] === undefined))
  const recentTasks = visibleTasks.slice(0, 3)
  const selectedGenericStream = genericParsed?.streams.find((stream) => stream.id === selectedStreamId)
  const canEnqueue = parsed !== null || selectedGenericStream?.available === true
  const viewTitle = activeView === 'new' ? '新建任务' : activeView === 'queue' ? '下载队列' : '历史记录'

  useEffect(() => {
    if (chosenQuality !== undefined && selectedQuality !== chosenQuality.qn) setSelectedQuality(chosenQuality.qn)
  }, [chosenQuality, selectedQuality])

  async function handleParse() {
    if (isParsing) return
    const value = input.trim()
    if (value === '') {
      setNotice({ kind: 'error', text: '先粘贴一个视频链接或平台短链。' })
      return
    }
    setIsParsing(true)
    setNotice(null)
    try {
      if (detectedPlatform === 'unknown' || detectedPlatform === null) {
        throw new Error('无法识别这个媒体链接，请检查链接是否完整。')
      }
      if (detectedPlatform === 'bilibili') {
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
        const availableStreams = result.streams.filter((stream) => stream.available)
        setSelectedStreamId((availableStreams.find((stream) => stream.kind === 'video' && (stream.combined || mode === 'video')) ?? availableStreams.find((stream) => stream.kind === 'video') ?? availableStreams[0])?.id ?? null)
        setNotice({ kind: 'success', text: `${platformLabel[detectedPlatform]}解析完成，已展示可用资源。` })
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
    if (isEnqueuing || (parsed === null && (genericParsed === null || selectedStreamId === null))) return
    setIsEnqueuing(true)
    try {
      const result = parsed !== null
        ? await createTask({
            platform: 'bilibili', input: parsed.input, bvid: parsed.bvid, cid: parsed.cid,
            qn: chosenQuality?.qn, qualityLabel: chosenQuality?.label, mode, audioContainer, title: parsed.title,
          })
        : await createTask({
            platform: genericParsed?.platform === 'unknown' ? undefined : genericParsed?.platform, input: genericParsed?.input,
            streamId: selectedStreamId ?? undefined,
            qualityLabel: selectedGenericStream === undefined
              ? undefined
              : selectedGenericStream.label || (selectedGenericStream.width !== undefined && selectedGenericStream.height !== undefined
                ? `${selectedGenericStream.width}×${selectedGenericStream.height}`
                : selectedGenericStream.codecs || selectedGenericStream.mimeType || (selectedGenericStream.kind === 'audio' ? '音频资源' : selectedGenericStream.kind === 'image' ? '图片资源' : '视频资源')),
            mode: selectedGenericStream?.kind === 'image' ? 'image' : mode, audioContainer, title: genericParsed?.title ?? '',
          })
      const task = result.task
      setTasks((current) => uniqueTaskList([task, ...current.filter((item) => item.id !== task.id)]))
      setInput('')
      setParsed(null)
      setGenericParsed(null)
      setSelectedStreamId(null)
      setSelectedQuality(null)
      if (task.platform !== 'unknown') setHistoryPlatform(task.platform)
      setActiveView((task.status === 'success' && downloadResults[task.id] !== undefined) || task.status === 'fail' || task.status === 'stopped' ? 'history' : 'queue')
      setNotice(result.deduplicated
        ? { kind: 'info', text: '相同下载配置已存在，未重复创建任务。' }
        : { kind: 'success', text: '任务已加入下载队列，完成后可从队列保存到本机。' })
    } catch (error) {
      setNotice({ kind: 'error', text: error instanceof Error ? error.message : '任务创建失败。' })
    } finally {
      setIsEnqueuing(false)
    }
  }

  async function saveSettings() {
    if (isSavingSettings) return
    setIsSavingSettings(true)
    try {
      const next = await patchConfig(draft)
      setConfig(next)
      setMode(next.defaultDownloadMode)
      setAudioContainer(next.audioContainer)
      setShowSettings(false)
      setNotice({ kind: 'success', text: '设置已保存。' })
    } catch (error) {
      setNotice({ kind: 'error', text: error instanceof Error ? error.message : '设置保存失败。' })
    } finally {
      setIsSavingSettings(false)
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
      setDownloadResults((current) => { const updated = { ...current }; delete updated[id]; return updated })
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
      setDownloadResults((current) => { const updated = { ...current }; delete updated[id]; return updated })
      setTasks((current) => current.filter((item) => item.id !== id))
      setNotice({ kind: 'success', text: '历史任务已删除。' })
    } catch (error) {
      setNotice({ kind: 'error', text: error instanceof Error ? error.message : '删除历史任务失败。' })
    }
  }

  function markTaskDownloaded(id: string, result: DownloadResult) {
    setDownloadResults((current) => ({ ...current, [id]: result }))
    setActiveView('history')
    setNotice(result.status === 'success'
      ? { kind: 'success', text: isTauriDesktop() ? '已打开已保存文件，任务已移入历史记录。' : '文件下载已开始，任务已移入历史记录。' }
      : { kind: 'error', text: `下载失败：${result.error ?? '请稍后重试。'}` })
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

  async function saveCookieAccount(platform: CookieAccountPlatform) {
    setCookieAccounts((current) => ({ ...current, [platform]: { ...current[platform], saving: true } }))
    try {
      const result = await saveCookie(platform, cookieAccounts[platform].cookie)
      setCookieAccounts((current) => ({ ...current, [platform]: { ...current[platform], cookie: '', configured: result.configured, saving: false } }))
      setNotice({ kind: 'success', text: `${platformLabel[platform]} Cookie 已加密保存。` })
    } catch (error) {
      setCookieAccounts((current) => ({ ...current, [platform]: { ...current[platform], saving: false } }))
      setNotice({ kind: 'error', text: error instanceof Error ? error.message : `${platformLabel[platform]} Cookie 保存失败。` })
    }
  }

  async function clearCookieAccount(platform: CookieAccountPlatform) {
    const actionId = `cookie:${platform}`
    if (accountAction !== null) return
    setAccountAction({ id: actionId, action: 'clear-cookie' })
    try {
      const result = await clearCookie(platform)
      setCookieAccounts((current) => ({ ...current, [platform]: { ...current[platform], cookie: '', configured: result.configured } }))
      setNotice({ kind: 'success', text: `${platformLabel[platform]} Cookie 已清除。` })
    } catch (error) {
      setNotice({ kind: 'error', text: error instanceof Error ? error.message : `${platformLabel[platform]} Cookie 清除失败。` })
    } finally {
      setAccountAction(null)
    }
  }

  async function activateBiliAccount(id: string) {
    if (accountAction !== null) return
    setAccountAction({ id, action: 'activate' })
    try {
      const account = await activateAccount(id)
      setAccounts((current) => current.map((item) => ({ ...item, active: item.id === id, ...(item.id === id ? account : {}) })))
      setNotice({ kind: 'success', text: `已切换到「${account.displayName || account.label}」。` })
    } catch (error) {
      setNotice({ kind: 'error', text: error instanceof Error ? error.message : '切换账号失败。' })
    } finally {
      setAccountAction(null)
    }
  }

  async function verifyBiliAccount(id: string) {
    if (accountAction !== null) return
    setAccountAction({ id, action: 'verify' })
    try {
      const account = await verifyAccount(id)
      setAccounts((current) => current.map((item) => item.id === id ? account : item))
      setNotice({ kind: 'success', text: `「${account.displayName || account.label}」登录状态有效。` })
    } catch (error) {
      setNotice({ kind: 'error', text: error instanceof Error ? error.message : '账号验证失败。' })
    } finally {
      setAccountAction(null)
    }
  }

  async function deleteBiliAccount(id: string) {
    if (accountAction !== null) return
    setAccountAction({ id, action: 'delete' })
    try {
      await removeAccount(id)
      setAccounts((current) => current.filter((item) => item.id !== id))
      setNotice({ kind: 'success', text: '账号及其本地凭据已删除。' })
    } catch (error) {
      setNotice({ kind: 'error', text: error instanceof Error ? error.message : '删除账号失败。' })
    } finally {
      setAccountAction(null)
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
          <button className={`nav-item ${activeView === 'queue' ? 'active' : ''}`} type="button" onClick={() => setActiveView('queue')}><ListChecks /><span>下载队列</span></button>
          <button className={`nav-item ${activeView === 'history' ? 'active' : ''}`} type="button" onClick={() => setActiveView('history')}><Clock3 /><span>历史记录</span></button>
        </nav>

        <div className="sidebar-label sources-label">平台来源</div>
        <nav className="source-nav" aria-label="平台筛选">
          {sourcePlatforms.map((platform) => (
            <button key={platform.platform} type="button" className={`source-item ${platform.platform} ${activePlatform === platform.platform ? 'selected' : ''}`} onClick={() => setActivePlatform(platform.platform)}>
              <span className="source-mark"><PlatformLogo platform={platform.platform} /></span>
              <span>{platform.label}</span>
              <span className={`source-state ${!platform.requiresExtractor || extractor?.available ? 'ready' : ''}`} />
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
              className={`core-status tooltip-target ${coreConnection === 'disconnected' ? 'error' : coreConnection}`}
              data-tooltip={coreStatusTooltip(coreConnection, health, extractor, coreRetryCount)}
              aria-label={coreStatusTooltip(coreConnection, health, extractor, coreRetryCount)}
              role="status"
              tabIndex={0}
            >
              <Server />
              <span className="core-status-dot" />
            </span>
          </div>
        </header>

        {activeView === 'new' && <section className="hero-panel">
          <div className="hero-heading">
            <div className="hero-copy">
              <h1 aria-label={heroTitle}><span className="hero-title-primary">{heroTitle.slice(0, Math.min(heroTitleLength, heroTitlePrimary.length))}</span><span className="hero-title-accent">{heroTitle.slice(heroTitlePrimary.length, heroTitleLength)}</span><span className="hero-caret" aria-hidden="true">|</span></h1>
              <p className="hero-subtitle">多平台媒体资源整理</p>
            </div>
            <div className="hero-platforms" aria-label="支持的平台">
              {sourcePlatforms.map((platform) => (
                <span className={`hero-platform ${platform.platform}`} key={platform.platform}><PlatformLogo platform={platform.platform} /><span>{platform.label}</span></span>
              ))}
            </div>
          </div>
          <div className="input-row">
            <div className="url-input-wrap">
              <span className="url-input-leading" aria-hidden="true"><Link2 className="input-link-icon" /></span>
              <div className={`url-input-field ${input.trim() !== '' ? 'has-value' : ''}`}>
                <input
                  ref={inputElementRef}
                  value={input}
                  onChange={(event) => setInput(event.target.value)}
                  onKeyDown={(event) => { if (event.key === 'Enter') void handleParse() }}
                  placeholder="粘贴媒体链接或分享链接"
                  aria-label="媒体链接"
                />
              </div>
              {detectedPlatform !== null && detectedPlatform !== 'unknown' && <span className={`detected-badge ${detectedPlatform}`} title={platformLabel[detectedPlatform]} aria-label={platformLabel[detectedPlatform]}><PlatformLogo platform={detectedPlatform} /></span>}
            </div>
            <button className="primary-button" type="button" onClick={() => void handleParse()} disabled={isParsing} aria-busy={isParsing}>
              {isParsing ? <LoaderCircle className="spin" /> : <Plus />}
              <span>{isParsing ? '正在解析' : '解析链接'}</span>
              {!isParsing && <ArrowRight className="button-trailing" />}
            </button>
          </div>
        </section>}

        {activeView === 'new' && <div className="workspace-grid">
          <MediaPreview parsed={parsed} genericParsed={genericParsed} selectedQuality={selectedQuality} selectedStreamId={selectedStreamId} isParsing={isParsing} onSelectQuality={setSelectedQuality} onSelectStream={setSelectedStreamId} onSelectPage={(page) => void handlePageChange(page)} />

          <div className="right-stack">
            <section className="panel output-panel">
              <div className="panel-heading compact-heading">
                <div className="heading-title"><span className="heading-icon"><FolderDown /></span><div><h2>保存设置</h2></div></div>
              </div>
              <div className="mode-list">
                {selectedGenericStream?.kind === 'image' ? <div className="mode-option selected"><span className="mode-choice"><span className="mode-radio" /><span className="mode-copy"><strong>保存图片</strong><small>保留原始图片格式；每次选择一张</small></span></span><span className="mode-check"><Check /></span></div> : modeOptions.map((option) => (
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
              <button className="queue-button" type="button" onClick={() => void enqueue()} disabled={!canEnqueue || isEnqueuing} aria-busy={isEnqueuing}>{isEnqueuing ? <LoaderCircle className="spin" /> : <ArrowDownToLine />}<span>{isEnqueuing ? '正在加入队列' : '加入下载队列'}</span></button>
            </section>

            <section className="panel tasks-panel">
              <div className="panel-heading compact-heading">
                <div className="heading-title"><span className="heading-icon"><ListChecks /></span><div><h2><span className="heading-main">最近任务</span><small className="heading-count">（{visibleTasks.length}项）</small></h2></div></div>
              </div>
              {recentTasks.length === 0 ? <div className="tasks-empty"><Clock3 /><span>新任务会显示在这里</span></div> : <div className="task-list">{recentTasks.map((task) => <TaskRow key={task.id} task={task} variant="compact" onCancel={stopTask} onRemove={removeHistoryTask} />)}</div>}
            </section>
          </div>
        </div>}

        {activeView !== 'new' && <section className="panel task-view-panel">
          <div className="panel-heading">
            <div className="heading-title"><span className="heading-icon">{activeView === 'queue' ? <ListChecks /> : <Clock3 />}</span><div><h2><span className="heading-main">{activeView === 'history' ? '历史记录' : '下载队列'}</span><small className="heading-count">（{activeView === 'history' ? historyTasks.length : queueTasks.length}项）</small></h2></div></div>
            <div ref={historyFilterRef} className="platform-filter" data-open={historyFilterOpen ? 'true' : 'false'}>
              <button className="platform-filter-trigger" type="button" aria-haspopup="listbox" aria-expanded={historyFilterOpen} onClick={() => setHistoryFilterOpen((open) => !open)}>
                <span className={`platform-filter-icon ${historyPlatform === 'all' || historyPlatform === 'unknown' ? 'douyin' : historyPlatform}`} aria-hidden="true">{historyPlatform === 'all' || historyPlatform === 'unknown' ? <Globe2 className="platform-filter-globe" /> : <PlatformLogo platform={historyPlatform} />}</span>
                <span>{historyPlatform === 'all' || historyPlatform === 'unknown' ? '全部来源' : platformLabel[historyPlatform]}</span>
                <ChevronDown className="platform-filter-chevron" />
              </button>
              {historyFilterOpen && <div className="platform-filter-menu" role="listbox" aria-label="任务平台筛选">
                <button className={historyPlatform === 'all' ? 'selected' : ''} type="button" role="option" aria-selected={historyPlatform === 'all'} onClick={() => { setHistoryPlatform('all'); setHistoryFilterOpen(false) }}><span className="platform-filter-icon douyin" aria-hidden="true"><Globe2 className="platform-filter-globe" /></span><span>全部来源</span>{historyPlatform === 'all' && <Check />}</button>
                {sourcePlatforms.map((platform) => <button className={historyPlatform === platform.platform ? 'selected' : ''} type="button" role="option" aria-selected={historyPlatform === platform.platform} key={platform.platform} onClick={() => { setHistoryPlatform(platform.platform); setHistoryFilterOpen(false) }}><span className={`platform-filter-icon ${platform.platform}`} aria-hidden="true"><PlatformLogo platform={platform.platform} /></span><span>{platform.label}</span>{historyPlatform === platform.platform && <Check />}</button>)}
              </div>}
            </div>
          </div>
          {(activeView === 'queue' ? queueTasks : historyTasks).length === 0 ? <div className="task-view-empty"><Clock3 /><strong>{activeView === 'queue' ? '当前没有下载任务' : '还没有历史任务'}</strong>{activeView === 'queue' && <span>从新建任务解析内容后加入下载队列。</span>}</div> : <div className="task-view-list">{(activeView === 'queue' ? queueTasks : historyTasks).map((task) => <TaskRow key={task.id} task={task} downloadDirectory={health?.config.resolvedSavePath} downloadResult={downloadResults[task.id]} onCancel={stopTask} onRetry={retryDownload} onRemove={removeHistoryTask} onDownloadResult={markTaskDownloaded} />)}</div>}
        </section>}
      </main>

      {visibleNotice !== null && createPortal(
        <div key={`${visibleNotice.kind}:${visibleNotice.text}`} className={`notice global-notice ${visibleNotice.kind}`} role="status">
          <span>{visibleNotice.kind === 'error' ? <X /> : visibleNotice.kind === 'success' ? <Check /> : coreConnection !== 'ready' ? <LoaderCircle className="spin" /> : <Activity />}</span>
          <span className="notice-message">{visibleNotice.text}</span>
        </div>, document.body,
      )}

      <TaskSearchDialog
        open={showTaskSearch}
        tasks={tasks}
        downloadResults={downloadResults}
        onClose={() => setShowTaskSearch(false)}
        onSelect={(task) => {
          if (isTerminalTask(task)) setHistoryPlatform(task.platform === 'unknown' ? 'all' : task.platform)
          setActiveView(isTerminalTask(task) ? 'history' : 'queue')
          setShowTaskSearch(false)
        }}
      />

      <SettingsModal
        open={showSettings}
        draft={draft}
        isSavingSettings={isSavingSettings}
        onDraftChange={(patch) => setDraft((current) => ({ ...current, ...patch }))}
        onPickDownloadDirectory={isTauriDesktop() ? () => {
          void chooseDownloadDirectory().then((directory) => {
            if (directory !== null) setDraft((current) => ({ ...current, savePath: directory }))
          }).catch((error) => setNotice({ kind: 'error', text: error instanceof Error ? error.message : '选择目录失败。' }))
        } : undefined}
        accounts={accounts}
        accountAction={accountAction}
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
        cookieAccounts={cookieAccounts}
        onCookieChange={(platform, value) => setCookieAccounts((current) => ({ ...current, [platform]: { ...current[platform], cookie: value } }))}
        onSaveCookie={(platform) => void saveCookieAccount(platform)}
        onClearCookie={(platform) => void clearCookieAccount(platform)}
      />
    </div>
  )
}

export default App
