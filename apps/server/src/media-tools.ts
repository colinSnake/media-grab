import { existsSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { findRepoRoot } from './paths.js'

export type MediaTool = 'ffmpeg' | 'yt-dlp'

function binaryName(tool: MediaTool): string {
  return process.platform === 'win32' ? `${tool}.exe` : tool
}

function isFile(candidate: string): boolean {
  try {
    return statSync(candidate).isFile()
  } catch {
    return false
  }
}

function targetName(): string {
  return `${process.platform}-${process.arch}`
}

/**
 * Finds a tool staged by the desktop bundle. `MEDIA_TOOLS_DIR` points to the
 * Tauri resource directory in packaged builds and is also useful in tests.
 */
export function resolveBundledTool(
  tool: MediaTool,
  moduleDir: string = path.dirname(fileURLToPath(import.meta.url)),
): string | undefined {
  const name = binaryName(tool)
  const target = targetName()
  const candidates: string[] = []
  const configuredDir = process.env.MEDIA_TOOLS_DIR?.trim()
  if (configuredDir !== undefined && configuredDir !== '') {
    candidates.push(path.resolve(configuredDir, target, name), path.resolve(configuredDir, name))
  }

  const root = findRepoRoot(moduleDir)
  if (root !== undefined) {
    const resourceDir = path.join(root, 'apps', 'desktop', 'src-tauri', 'resources', 'media-tools')
    candidates.push(path.join(resourceDir, target, name), path.join(resourceDir, name))
  }

  return candidates.find(isFile)
}

export function resolveFfmpegExecutable(
  configuredPath = '',
  moduleDir?: string,
): string {
  return configuredPath.trim() || resolveBundledTool('ffmpeg', moduleDir) || 'ffmpeg'
}

export function resolveYtDlpExecutable(
  configuredPath = '',
  moduleDir?: string,
): string {
  return configuredPath.trim() || resolveBundledTool('yt-dlp', moduleDir) || 'yt-dlp'
}
