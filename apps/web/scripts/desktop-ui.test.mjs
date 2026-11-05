import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

let vite, UpscaleEngineProvider, GlobalUpscaleEngineStatus, UpscaleTaskCard, UpscalePage, UpscaleEngineStatus, DownloadServiceStatus, UpscaleProbeLoader, installDesktopContextMenuGuard
before(async () => {
  // Load actual TS/TSX with the project's existing Vite; no browser, ports, or user tasks.
  vite = await createServer({ root: fileURLToPath(new URL('../', import.meta.url)), configFile: false, appType: 'custom', logLevel: 'error', optimizeDeps: { noDiscovery: true, include: [] }, esbuild: { jsx: 'automatic' }, server: { middlewareMode: true, hmr: false, watch: null } })
  ;({ UpscaleEngineProvider, GlobalUpscaleEngineStatus } = await vite.ssrLoadModule('/src/components/UpscaleEngineProvider.tsx'))
  ;({ UpscalePage } = await vite.ssrLoadModule('/src/components/UpscalePage.tsx'))
  ;({ UpscaleEngineStatus } = await vite.ssrLoadModule('/src/components/UpscaleEngineStatus.tsx'))
  ;({ DownloadServiceStatus } = await vite.ssrLoadModule('/src/components/DownloadServiceStatus.tsx'))
  ;({ UpscaleProbeLoader } = await vite.ssrLoadModule('/src/lib/upscale-probe.ts'))
  ;({ UpscaleTaskCard } = await vite.ssrLoadModule('/src/components/UpscaleTaskCard.tsx'))
  ;({ installDesktopContextMenuGuard } = await vite.ssrLoadModule('/src/lib/desktop-context-menu.ts'))
})
after(async () => { await vite?.close() })

const fixture = { id: 'fixture', input: '/fixture/源视频.mp4', output: '/fixture/成片.mp4', model: 'realesr-animevideov3-x2', stage: 'encoding', completedFrames: 12, media: { width: 128, height: 72, fps: '24/1', frames: 24, duration: 1, audio: true }, createdAt: 1, updatedAt: 1 }
const render = (status, busy = false, extra = {}) => renderToStaticMarkup(createElement(UpscaleTaskCard, { task: { ...fixture, status, ...extra }, busy, onCancel() {}, onOpen() {}, onRemove() {} }))

test('upscale queue exposes deletion for queued and all terminal states, never while running', () => {
  for (const status of ['queued', 'succeeded', 'failed', 'cancelled', 'interrupted']) {
    const html = render(status)
    assert.match(html, /aria-label="删除任务 成片.mp4"/)
    assert.match(html, /只删除任务记录，不删除源视频或成片/)
    assert.equal(html.includes('取消任务'), status === 'queued')
  }
  assert.doesNotMatch(render('running'), /aria-label="删除任务/)
  assert.match(render('running'), /取消任务/)
})
test('success keeps open-output action beside delete; busy cards disable actions', () => {
  const result = { path: fixture.output, bytes: 1, sha256: 'a'.repeat(64) }
  const html = render('succeeded', false, { result })
  assert.match(html, /打开成片/); assert.match(html, /upscale-job-remove/)
  assert.match(html, /100%/)
  const buttons = [...render('succeeded', true, { result }).matchAll(/<button\b[^>]*>/g)]
  assert.equal(buttons.length, 2)
  for (const [button] of buttons) assert.match(button, /disabled=""/)
})
test('desktop context menu is suppressed without blocking app-owned handlers or copy shortcuts', () => {
  const target = Object.assign(new EventTarget(), { __TAURI_INTERNALS__: {} })
  let appMenuEvents = 0
  target.addEventListener('contextmenu', () => { appMenuEvents++ })
  const remove = installDesktopContextMenuGuard(target)
  const rightClick = new Event('contextmenu', { cancelable: true })
  assert.equal(target.dispatchEvent(rightClick), false); assert.equal(rightClick.defaultPrevented, true)
  assert.equal(appMenuEvents, 1)
  for (const type of ['click', 'keydown', 'copy', 'paste']) {
    const event = new Event(type, { cancelable: true })
    assert.equal(target.dispatchEvent(event), true)
  }
  remove()
  assert.equal(target.dispatchEvent(new Event('contextmenu', { cancelable: true })), true)
})
test('ordinary browser retains its native context menu', () => {
  const target = new EventTarget(), remove = installDesktopContextMenuGuard(target)
  assert.equal(target.dispatchEvent(new Event('contextmenu', { cancelable: true })), true)
  remove()
})


const deferred = () => {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const selection = { input: { path: '/fixture/video.mp4', proof: 'input-proof' }, directory: { path: '/fixture/output', proof: 'directory-proof' } }
const checked = (grant) => ({ grant, media: fixture.media })

test('upscale form keeps only the initiate CTA, without a shared loading spinner', () => {
  const html = renderToStaticMarkup(createElement(UpscaleEngineProvider, null, createElement(UpscalePage)))
  const actions = html.match(/<div class="upscale-actions">(.*?)<\/div>/s)?.[1]
  assert.ok(actions)
  assert.equal([...actions.matchAll(/<button\b/g)].length, 1)
  assert.match(actions, /发起超分/)
  assert.match(actions, /aria-busy="false"/)
  assert.doesNotMatch(actions, /spin/)
  assert.doesNotMatch(html, /探测媒体|开始 2× 超分/)
  assert.match(html, /一键超分/)
  assert.doesNotMatch(html, /选择源视频和保存位置后自动检查|upscale-model|Real-ESRGAN AnimeVideo|realesr-animevideov3-x2|upscale-engine-trigger/)
})
test('automatic checks deduplicate the same pending selection and reuse a fresh grant', async () => {
  const pending = deferred(), calls = []
  const loader = new UpscaleProbeLoader((value) => { calls.push(value); return pending.promise })
  const first = loader.prepare(selection), second = loader.prepare(selection)
  assert.equal(first, second)
  await Promise.resolve(); assert.equal(calls.length, 1)
  pending.resolve(checked('first')); await first
  assert.equal((await loader.prepare(selection)).grant, 'first')
  assert.equal(calls.length, 1)
})
test('changing a selection queues a new check after the old one, never concurrently', async () => {
  const a = deferred(), b = deferred(), calls = []
  const loader = new UpscaleProbeLoader((value) => { calls.push(value); return calls.length === 1 ? a.promise : b.promise })
  const other = { ...selection, input: { ...selection.input, path: '/fixture/other.mp4' } }
  const first = loader.prepare(selection), second = loader.prepare(other)
  await Promise.resolve(); assert.equal(calls.length, 1)
  a.resolve(checked('old')); await first
  // Allow the chained request to start after first's finally/catch microtasks.
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(calls.length, 2); assert.deepEqual(calls[1], other)
  b.resolve(checked('new')); await second
  assert.equal(loader.peek(other).grant, 'new')
  assert.equal(loader.peek(selection), undefined)
})
test('failed checks can retry and do not block the next selection', async () => {
  const pending = deferred(); let calls = 0
  const loader = new UpscaleProbeLoader(() => ++calls === 1 ? pending.promise : Promise.resolve(checked('retry')))
  const first = loader.prepare(selection)
  const other = { ...selection, directory: { ...selection.directory, path: '/fixture/elsewhere' } }
  const second = loader.prepare(other)
  const failure = assert.rejects(first, /invalid fixture/)
  pending.reject(new Error('invalid fixture')); await failure
  assert.equal((await second).grant, 'retry'); assert.equal(calls, 2)
})
test('grants renew before expiry and are never reused after submission', async () => {
  let now = 0, calls = 0
  const loader = new UpscaleProbeLoader(async () => checked(`grant-${++calls}`), () => now)
  assert.equal((await loader.prepare(selection)).grant, 'grant-1')
  now = 9 * 60_000 - 1; assert.equal((await loader.prepare(selection)).grant, 'grant-1')
  now++; assert.equal(loader.peek(selection), undefined)
  assert.equal((await loader.prepare(selection)).grant, 'grant-2')
  loader.invalidate(); assert.equal(loader.peek(selection), undefined)
  assert.equal((await loader.prepare(selection)).grant, 'grant-3')
})
test('reselecting a file invalidates even a still-pending check', async () => {
  const pending = deferred(); let calls = 0
  const loader = new UpscaleProbeLoader(() => ++calls === 1 ? pending.promise : Promise.resolve(checked('fresh')))
  const first = loader.prepare(selection)
  loader.invalidate()
  const second = loader.prepare(selection)
  assert.notEqual(first, second)
  pending.resolve(checked('obsolete')); await first
  assert.equal((await second).grant, 'fresh')
  assert.equal(loader.peek(selection).grant, 'fresh')
})
test('a changed native selection proof cannot reuse the previous authorization', async () => {
  let calls = 0
  const loader = new UpscaleProbeLoader(async () => checked(`grant-${++calls}`))
  await loader.prepare(selection)
  const other = { ...selection, input: { ...selection.input, proof: 'changed-proof' } }
  assert.equal(loader.peek(other), undefined)
  assert.equal((await loader.prepare(other)).grant, 'grant-2')
})


test('upscale status is an accessible icon-only entrance, without the old model capsule', () => {
  const html = renderToStaticMarkup(createElement(UpscaleEngineStatus, { capability: { available: true }, onRetry() {} }))
  assert.match(html, /icon-button service-status-trigger upscale-engine-trigger ready/)
  assert.match(html, /lucide-cpu/)
  assert.doesNotMatch(html, /lucide-wand-sparkles/)
  assert.match(html, /service-status-dot/)
  assert.match(html, /aria-haspopup="dialog"/)
  assert.match(html, /aria-expanded="false"/)
  assert.match(html, /aria-label="超分引擎：引擎就绪，查看详情"/)
  assert.doesNotMatch(html, /AnimeVideo|2×|upscale-engine-name|lucide-chevron|role="dialog"/)
  assert.equal(html.replace(/<[^>]*>/g, ''), '')
})
test('upscale icon distinguishes checking from unavailable capability and request failure', () => {
  const renderEngine = (capability, error) => renderToStaticMarkup(createElement(UpscaleEngineStatus, { capability, error, onRetry() {} }))
  const checking = renderEngine(null)
  assert.match(checking, /upscale-engine-trigger checking/)
  assert.match(checking, /超分引擎：检查中/)
  assert.doesNotMatch(checking, /spin/)
  for (const html of [renderEngine({ available: false, reason: 'fixture engine missing' }), renderEngine(null, 'fixture request failed')]) {
    assert.match(html, /upscale-engine-trigger unavailable/)
    assert.match(html, /超分引擎：引擎不可用/)
  }
})
test('download service shares the icon entrance and reflects service and yt-dlp status', () => {
  const available = { available: true, version: 'fixture-version', path: '/fixture/yt-dlp', error: '' }
  for (const [connection, extractor, state, label] of [
    ['ready', available, 'ready', '已就绪'],
    ['ready', null, 'checking', '检查中'],
    ['ready', { ...available, available: false }, 'unavailable', '依赖不可用'],
    ['connecting', available, 'checking', '连接中'],
    ['disconnected', available, 'unavailable', '未连接'],
  ]) {
    const html = renderToStaticMarkup(createElement(DownloadServiceStatus, { connection, extractor, retryCount: 0 }))
    assert.match(html, new RegExp('icon-button service-status-trigger download-service-trigger '+state))
    assert.ok(html.includes('aria-label="下载服务：'+label+'，查看详情"'))
    assert.match(html, /lucide-server/)
    assert.match(html, /service-status-dot/)
    assert.match(html, /aria-haspopup="dialog"/)
    assert.ok(html.includes('data-tooltip="下载服务 · '+label+'"'))
    assert.doesNotMatch(html, /\btitle=|role="dialog"/)
    assert.equal(html.replace(/<[^>]*>/g, ''), '')
  }
})


test('compact upscale cards use a first-frame cover, one-line title and source subtitle', () => {
  const html = render('succeeded')
  assert.match(html, /class="upscale-job-cover"/)
  assert.match(html, /upscale-job-title-row.*upscale-task-status succeeded/s)
  assert.match(html, /源文件 · 源视频\.mp4/)
  assert.match(html, /data-tooltip="成片\.mp4"/)
  assert.match(html, /data-tooltip="源视频\.mp4"/)
  assert.doesNotMatch(html, /-webkit-line-clamp: 2|upscale-job-icon|<video/)
  assert.equal([...html.matchAll(/>已完成</g)].length, 1)
  assert.match(html, /upscale-job-media.*upscale-resolution-block.*upscale-details-block.*upscale-media-tags/s)
  assert.match(html, /upscale-media-heading.*分辨率.*upscale-scale-tag.*2×.*upscale-details-block.*媒体参数.*upscale-media-tags/s)
})
test('upscale headings and filter reuse history task-list typography and controls', () => {
  const html = renderToStaticMarkup(createElement(UpscaleEngineProvider, null, createElement(UpscalePage)))
  assert.match(html, /panel-heading upscale-panel-heading/)
  assert.match(html, /panel-heading upscale-jobs-heading/)
  assert.match(html, /heading-main">一键超分/)
  assert.match(html, /class="heading-count"/)
  assert.match(html, /class="platform-filter-trigger"/)
  assert.match(html, /aria-label="超分任务筛选：全部任务"/)
})


test('global engine indicator renders without mounting the upscale page', () => {
  const html = renderToStaticMarkup(createElement(UpscaleEngineProvider, null, createElement(GlobalUpscaleEngineStatus)))
  assert.match(html, /upscale-engine-trigger/)
  assert.doesNotMatch(html, /upscale-page|upscale-job-list/)
})


test('app mounts the shared engine status unconditionally after the download indicator', async () => {
  const app = await readFile(new URL('../src/App.tsx', import.meta.url), 'utf8')
  assert.match(app, /<UpscaleEngineProvider connection=\{coreConnection\}>/)
  assert.match(app, /<DownloadServiceStatus[^>]*\/>\s*<GlobalUpscaleEngineStatus \/>/)
  assert.match(app, /activeView === 'upscale' && <UpscalePage \/>/)
  assert.doesNotMatch(app, /engineSlot|upscaleEngineSlot/)
})


test('global engine status reports core disconnection without stale readiness', () => {
  const html = renderToStaticMarkup(createElement(UpscaleEngineProvider, { connection: 'disconnected' }, createElement(GlobalUpscaleEngineStatus)))
  assert.match(html, /upscale-engine-trigger unavailable/)
  assert.match(html, /超分引擎：引擎不可用/)
  assert.doesNotMatch(html, /upscale-engine-trigger ready/)
})
