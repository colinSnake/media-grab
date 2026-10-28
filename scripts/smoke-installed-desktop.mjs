/** Start an installed desktop app/binary, not the Node core in the checkout. */
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { connect } from 'node:net'
import { mkdir, mkdtemp, readFile, readlink, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const executable = process.argv[2]
if (!executable || !path.isAbsolute(executable)) {
  throw new Error('Usage: node scripts/smoke-installed-desktop.mjs <absolute installed executable or app bundle path>')
}
if (!['win32', 'linux', 'darwin'].includes(process.platform)) {
  throw new Error('The installer smoke test supports Windows, Linux, and macOS CI runners only')
}

function portOpen() {
  return new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port: 9070 })
    socket.setTimeout(1000)
    socket.once('connect', () => { socket.destroy(); resolve(true) })
    socket.once('error', () => { socket.destroy(); resolve(false) })
    socket.once('timeout', () => { socket.destroy(); resolve(false) })
  })
}

async function getJson(route) {
  const response = await fetch(`http://127.0.0.1:9070${route}`, { signal: AbortSignal.timeout(2000) })
  assert.equal(response.status, 200, `${route}: HTTP ${response.status}`)
  return response.json()
}

function bundledNodeExecutable(pid) {
  if (process.platform === 'linux') return readlink(`/proc/${pid}/exe`)
  if (process.platform === 'darwin') {
    const result = spawnSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8', timeout: 10000 })
    if (result.status !== 0) throw new Error(`Cannot inspect bundled Node process: ${result.stderr?.trim()}`)
    return Promise.resolve(result.stdout.trim().split(/\s+/, 1)[0] ?? '')
  }
  const command = `(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').ExecutablePath`
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8', timeout: 10000 })
  if (result.status !== 0) throw new Error(`Cannot inspect bundled Node process: ${result.stderr?.trim()}`)
  return Promise.resolve(result.stdout.trim())
}

async function stopTree(child) {
  if (child?.pid === undefined) return
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { timeout: 10000, stdio: 'ignore' })
  } else if (process.platform === 'darwin') {
    spawnSync('osascript', ['-e', 'tell application id "com.mediagrab.desktop" to quit'], { timeout: 10000, stdio: 'ignore' })
    await new Promise((resolve) => setTimeout(resolve, 1500))
    try { child.kill('SIGTERM') } catch (error) { if (error.code !== 'ESRCH') throw error }
  } else {
    try { process.kill(-child.pid, 'SIGTERM') } catch (error) { if (error.code !== 'ESRCH') throw error }
  }
  await new Promise((resolve) => setTimeout(resolve, 600))
  if (process.platform === 'linux') {
    try { process.kill(-child.pid, 'SIGKILL') } catch (error) { if (error.code !== 'ESRCH') throw error }
  } else if (process.platform === 'darwin') {
    try { child.kill('SIGKILL') } catch (error) { if (error.code !== 'ESRCH') throw error }
  }
}

if (await portOpen()) throw new Error('Port 9070 was already occupied before launching the installer: cannot trust the health check')
const temporaryDir = await mkdtemp(path.join(os.tmpdir(), 'mediagrab-installed-smoke-'))
let child
let stderr = ''
let success = false
let mountedDmg
try {
  let launchTarget = executable
  if (process.platform === 'darwin' && executable.toLowerCase().endsWith('.dmg')) {
    const mountpoint = path.join(temporaryDir, 'dmg')
    await mkdir(mountpoint, { recursive: true })
    const mounted = spawnSync('hdiutil', ['attach', '-readonly', '-nobrowse', '-mountpoint', mountpoint, executable], { encoding: 'utf8', timeout: 30000 })
    if (mounted.status !== 0) throw new Error(`Cannot mount DMG: ${mounted.stderr?.trim() || mounted.stdout?.trim()}`)
    mountedDmg = mountpoint
    launchTarget = path.join(mountpoint, 'MediaGrab.app')
  }
  const env = { ...process.env }
  const unsafeOverrides = new Set(['DATA_DIR', 'DB_PATH', 'WEB_DIST', 'MEDIA_TOOLS_DIR', 'HOST', 'PORT', 'NODE_OPTIONS', 'NODE_PATH'])
  for (const name of Object.keys(env)) {
    if (unsafeOverrides.has(name.toUpperCase())) delete env[name]
  }
  // Windows environment variable names are case-insensitive; update the original
  // key rather than accidentally passing both "Path" and "PATH" to CreateProcess.
  const pathKey = Object.keys(env).find((name) => name.toUpperCase() === 'PATH') ?? 'PATH'
  env[pathKey] = (env[pathKey] ?? '').split(path.delimiter)
    .filter((item) => !/hostedtoolcache|[\\/]nodejs[\\/]?$|[\\/]pnpm[\\/]?/i.test(item))
    .join(path.delimiter)
  let expectedDataRoot
  if (process.platform === 'darwin') {
    const home = path.join(temporaryDir, 'home')
    await mkdir(home, { recursive: true })
    env.HOME = home
    expectedDataRoot = path.join(home, 'Library', 'Application Support', 'com.mediagrab.desktop')
  } else {
    expectedDataRoot = path.join(temporaryDir, process.platform === 'win32' ? 'appdata' : 'xdg')
    const dataKey = process.platform === 'win32' ? 'APPDATA' : 'XDG_DATA_HOME'
    const existingDataKey = Object.keys(env).find((name) => name.toUpperCase() === dataKey) ?? dataKey
    env[existingDataKey] = expectedDataRoot
  }

  const appStderr = path.join(temporaryDir, 'app.stderr.log')
  if (process.platform === 'darwin') {
    child = spawn('open', ['-n', '-W', '--env', `HOME=${env.HOME}`, '--env', `TMPDIR=${temporaryDir}`, '--stderr', appStderr, launchTarget], { env, stdio: ['ignore', 'ignore', 'pipe'] })
  } else {
    child = spawn(executable, [], { env, detached: process.platform !== 'win32', stdio: ['ignore', 'ignore', 'pipe'] })
  }
  child.stderr?.on('data', (chunk) => { stderr = `${stderr}${chunk.toString()}`.slice(-3000) })
  let exit
  child.once('error', (error) => { exit = error })
  child.once('exit', (code, signal) => { exit = new Error(`desktop exited early (${code ?? signal})`) })

  const deadline = Date.now() + 45_000
  let health
  while (Date.now() < deadline && !health && !exit) {
    try { health = await getJson('/api/health') } catch { await new Promise((resolve) => setTimeout(resolve, 350)) }
  }
  if (!health) {
    const diagnostics = await Promise.all([
      readFile(appStderr, 'utf8').catch(() => ''),
      readFile(path.join(expectedDataRoot, 'logs', 'core.log'), 'utf8').catch(() => ''),
    ])
    throw new Error(`Packaged desktop did not start its local core: ${exit?.message ?? 'timeout'}\n${stderr}\n${diagnostics.join('\n')}`)
  }
  assert.equal(health.ok, true)
  assert.equal(health.web.built, true)
  assert.equal(health.bili.db.ok, true)
  assert.equal(health.listen.host, '127.0.0.1')
  assert.equal(health.listen.port, 9070)
  const dbPath = path.resolve(health.bili.db.path)
  assert.ok(dbPath.toLowerCase().startsWith(`${expectedDataRoot.toLowerCase()}${path.sep}`), `DB outside isolated app data: ${dbPath}`)
  const nodeExecutable = await bundledNodeExecutable(health.runtime.pid)
  assert.match(nodeExecutable, /[\\/]resources[\\/]core[\\/]node(?:\.exe)?$/i, `Core used host Node: ${nodeExecutable}`)
  // The isolated-runtime check above tests FFmpeg/yt-dlp directly. A packaged
  // desktop must *not* expose config/account/tool routes to an unauthenticated
  // process such as this smoke harness.
  const denied = await fetch('http://127.0.0.1:9070/api/config', { signal: AbortSignal.timeout(2000) })
  assert.equal(denied.status, 403, 'Installed core did not enforce per-launch authentication')
  const error = await denied.json()
  assert.equal(error.error?.code, 'CORE_AUTH_REQUIRED')
  if (exit) throw exit
  console.log(JSON.stringify({ result: 'ok', platform: process.platform, database: 'isolated-app-data', node: 'bundled', apiAuth: 'enforced' }))
  success = true
} catch (error) {
  console.error(`Installer smoke failed; local core logs (if any): ${temporaryDir}`)
  throw error
} finally {
  await stopTree(child)
  const deadline = Date.now() + 8000
  while (await portOpen() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 250))
  const stillRunning = await portOpen()
  if (mountedDmg) spawnSync('hdiutil', ['detach', mountedDmg, '-force'], { stdio: 'ignore', timeout: 30000 })
  if (success) await rm(temporaryDir, { recursive: true, force: true }).catch(() => {})
  if (stillRunning && success) throw new Error('Packaged core remained listening after desktop shutdown')
}
