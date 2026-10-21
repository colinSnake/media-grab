import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import type { MediaParseResult, MediaStream, Platform } from '@mediagrab/shared'
import { ApiError } from '../lib/errors.js'
import type { Logger } from '../lib/logger.js'
import { silentLogger } from '../lib/logger.js'
import { findRepoRoot } from '../paths.js'

const execFileAsync = promisify(execFile)
const moduleDir = path.dirname(fileURLToPath(import.meta.url))
type ExecLike = (
  file: string,
  args: readonly string[],
  options: { timeout: number; maxBuffer: number },
) => Promise<{ stdout: string; stderr: string }>

interface YtDlpFormat {
  format_id?: string | number
  url?: string
  manifest_url?: string
  vcodec?: string
  acodec?: string
  width?: number
  height?: number
  fps?: number
  tbr?: number
  filesize?: number
  filesize_approx?: number
  ext?: string
  protocol?: string
  mime?: string
  http_headers?: Record<string, string>
}

interface YtDlpInfo {
  id?: string | number
  title?: string
  uploader?: string
  channel?: string
  thumbnail?: string
  duration?: number
  webpage_url?: string
  extractor_key?: string
  formats?: YtDlpFormat[]
}

function isPresent(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== ''
}

function normalizeCoverUrl(url: string): string {
  return url.replace(/^http:\/\//i, 'https://')
}

function projectYtDlpPath(root: string): string {
  return process.platform === 'win32'
    ? path.join(root, '.venv', 'Scripts', 'yt-dlp.exe')
    : path.join(root, '.venv', 'bin', 'yt-dlp')
}

/** 项目虚拟环境优先于系统 PATH，避免开发环境依赖全局 Python。 */
export function resolveProjectYtDlp(): string | undefined {
  const root = findRepoRoot(moduleDir) ?? findRepoRoot(process.cwd())
  if (root === undefined) return undefined
  const executable = projectYtDlpPath(root)
  return existsSync(executable) ? executable : undefined
}

function defaultYtDlpExecutable(): string {
  return resolveProjectYtDlp() ?? 'yt-dlp'
}

function streamFromFormat(format: YtDlpFormat, index: number): MediaStream | undefined {
  if (!isPresent(format.url)) return undefined
  const video = isPresent(format.vcodec) && format.vcodec !== 'none'
  const audio = isPresent(format.acodec) && format.acodec !== 'none'
  if (!video && !audio) return undefined
  const kind = video ? 'video' : 'audio'
  return {
    id: String(format.format_id ?? `${kind}-${index}`),
    kind,
    combined: video && audio,
    label: video
      ? `${Math.min(format.width ?? format.height ?? 0, format.height ?? format.width ?? 0)}P${format.fps !== undefined ? ` ${format.fps}fps` : ''}`
      : `${Math.round(format.tbr ?? 0)}K`,
    url: format.url,
    backupUrls: [],
    width: format.width,
    height: format.height,
    codecs: [format.vcodec, format.acodec].filter(isPresent).join(', '),
    mimeType: format.mime,
    bitrate: format.tbr === undefined ? undefined : Math.round(format.tbr * 1000),
    sizeBytes: format.filesize ?? format.filesize_approx,
    available: true,
    reason: '',
  }
}

export interface YtDlpAdapterOptions {
  platform: Exclude<Platform, 'bilibili' | 'unknown'>
  executable?: string
  cookieProvider?: () => string | undefined
  logger?: Logger
  exec?: ExecLike
}

export class YtDlpAdapter {
  readonly platform: Exclude<Platform, 'bilibili' | 'unknown'>
  #executable: string
  #allowPythonFallback: boolean
  #cookieProvider: () => string | undefined
  #logger: Logger
  #exec: ExecLike

  constructor(options: YtDlpAdapterOptions) {
    this.platform = options.platform
    this.#executable = options.executable?.trim() || defaultYtDlpExecutable()
    this.#allowPythonFallback = !options.executable?.trim()
    this.#cookieProvider = options.cookieProvider ?? (() => undefined)
    this.#logger = options.logger ?? silentLogger
    this.#exec = options.exec ?? (execFileAsync as unknown as ExecLike)
  }

  setExecutable(candidate = ''): void {
    this.#executable = candidate.trim() || defaultYtDlpExecutable()
    this.#allowPythonFallback = candidate.trim() === ''
  }

  setCookieProvider(provider: () => string | undefined): void {
    this.#cookieProvider = provider
  }

  private async run(args: readonly string[]): Promise<{ stdout: string; stderr: string }> {
    let cookieDir: string | undefined
    let commandArgs = [...args]
    try {
      const cookieContents = this.#cookieProvider()
      if (cookieContents !== undefined && cookieContents !== '') {
        cookieDir = await mkdtemp(path.join(os.tmpdir(), 'mediagrab-ytdlp-'))
        await chmod(cookieDir, 0o700)
        const cookiePath = path.join(cookieDir, 'cookies.txt')
        await writeFile(cookiePath, cookieContents, { mode: 0o600 })
        await chmod(cookiePath, 0o600)
        commandArgs = ['--cookies', cookiePath, ...args]
      }
      return await this.#exec(this.#executable, commandArgs, { timeout: 45_000, maxBuffer: 16 * 1024 * 1024 })
    } catch (error) {
      if (!this.#allowPythonFallback || !/not found|enoent|cannot find/i.test(error instanceof Error ? error.message : String(error))) {
        throw error
      }
      return this.#exec('python3', ['-m', 'yt_dlp', ...commandArgs], { timeout: 45_000, maxBuffer: 16 * 1024 * 1024 })
    } finally {
      if (cookieDir !== undefined) await rm(cookieDir, { recursive: true, force: true })
    }
  }

  async parse(input: string): Promise<MediaParseResult> {
    let stdout: string
    try {
      const args = ['--dump-single-json', '--no-warnings', '--no-playlist', '--skip-download']
      args.push(input)
      const result = await this.run(args)
      stdout = result.stdout
    } catch (error) {
      this.#logger.warn({ platform: this.platform, error: error instanceof Error ? error.message : String(error) }, 'yt-dlp 解析失败')
      const message = error instanceof Error ? error.message : String(error)
      if (/not found|enoent|cannot find/i.test(message)) {
        throw new ApiError('EXTRACTOR_UNAVAILABLE', '未找到 yt-dlp。请安装 yt-dlp 并将其加入 PATH，或在设置中配置可执行文件路径。', 'fatal', 503)
      }
      if (/unsupported url|no suitable extractor/i.test(message)) {
        throw new ApiError('UNSUPPORTED_MEDIA_URL', '该链接不是当前平台支持的媒体地址，或短链已经失效。', 'invalid', 422)
      }
      if (/private video|login required|video unavailable|not available in your country/i.test(message)) {
        throw new ApiError('MEDIA_PERMISSION_DENIED', '该内容需要登录、受限或当前身份无权访问。', 'permission', 403)
      }
      if (/fresh cookies|cookies.*needed|cookies.*required/i.test(message)) {
        const label = this.platform === 'douyin' ? '抖音' : '小红书'
        throw new ApiError('MEDIA_COOKIE_REQUIRED', `${label}需要新鲜的 Cookie。请在平台设置中粘贴有效 Cookie后重试。`, 'permission', 403)
      }
      throw new ApiError('EXTRACTOR_FAILED', `${this.platform === 'douyin' ? '抖音' : '小红书'}解析失败：${message}`, 'network', 502)
    }

    let info: YtDlpInfo
    try {
      const start = stdout.indexOf('{')
      const end = stdout.lastIndexOf('}')
      if (start < 0 || end <= start) throw new Error('JSON object not found')
      info = JSON.parse(stdout.slice(start, end + 1)) as YtDlpInfo
    } catch {
      throw new ApiError('EXTRACTOR_INVALID_OUTPUT', 'yt-dlp 返回了无法识别的媒体信息', 'fatal', 502)
    }

    const streams = (info.formats ?? [])
      .map(streamFromFormat)
      .filter((item): item is MediaStream => item !== undefined)
    const video = streams.some((stream) => stream.kind === 'video')
    const audio = streams.some((stream) => stream.kind === 'audio' || stream.combined)
    return {
      platform: this.platform,
      input,
      id: String(info.id ?? info.webpage_url ?? input),
      title: info.title ?? '',
      authorName: info.uploader ?? info.channel ?? '',
      cover: normalizeCoverUrl(info.thumbnail ?? ''),
      durationSec: Math.max(0, Math.round(info.duration ?? 0)),
      streams,
      itemCount: 1,
      capabilities: { video, audio, image: false, download: streams.length > 0 },
    }
  }
}

export async function checkYtDlp(candidate = ''): Promise<{ available: boolean; path: string; version: string; error: string }> {
  const executable = candidate.trim() || defaultYtDlpExecutable()
  try {
    const result = await execFileAsync(executable, ['--version'], { timeout: 5_000 })
    return { available: true, path: executable, version: result.stdout.trim(), error: '' }
  } catch (error) {
    if (candidate.trim() === '' && /not found|enoent|cannot find/i.test(error instanceof Error ? error.message : String(error))) {
      try {
        const result = await execFileAsync('python3', ['-m', 'yt_dlp', '--version'], { timeout: 5_000 })
        return { available: true, path: 'python3 -m yt_dlp', version: result.stdout.trim(), error: '' }
      } catch {
        // Return the direct command's error below so the user sees the PATH issue.
      }
    }
    return { available: false, path: executable, version: '', error: error instanceof Error ? error.message : String(error) }
  }
}
