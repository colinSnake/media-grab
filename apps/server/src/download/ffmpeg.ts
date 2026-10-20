import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export interface FfmpegStatus {
  available: boolean
  path: string
  version: string
  error: string
}

export async function checkFfmpeg(candidate = ''): Promise<FfmpegStatus> {
  const executable = candidate.trim() || 'ffmpeg'
  try {
    const result = await execFileAsync(executable, ['-version'], { timeout: 5_000 })
    const firstLine = result.stdout.split('\n', 1)[0]?.trim() ?? ''
    return { available: true, path: executable, version: firstLine, error: '' }
  } catch (error) {
    return {
      available: false,
      path: executable,
      version: '',
      error: error instanceof Error ? error.message : String(error),
    }
  }
}
