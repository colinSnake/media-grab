import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveBundledTool, resolveFfmpegExecutable, resolveYtDlpExecutable } from './media-tools.js'

const originalToolsDir = process.env.MEDIA_TOOLS_DIR

afterEach(() => {
  if (originalToolsDir === undefined) delete process.env.MEDIA_TOOLS_DIR
  else process.env.MEDIA_TOOLS_DIR = originalToolsDir
})

describe('media tool resolution', () => {
  it('resolves staged tools from MEDIA_TOOLS_DIR and the current target', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'mediagrab-tools-'))
    try {
      const target = `${process.platform}-${process.arch}`
      const toolName = process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp'
      const targetDir = path.join(root, target)
      await mkdir(targetDir, { recursive: true })
      const executable = path.join(targetDir, toolName)
      await writeFile(executable, '#!/bin/sh\n')
      if (process.platform !== 'win32') await chmod(executable, 0o755)
      process.env.MEDIA_TOOLS_DIR = root

      expect(resolveBundledTool('yt-dlp')).toBe(executable)
      expect(resolveYtDlpExecutable()).toBe(executable)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('keeps an explicit configured path ahead of bundled tools', () => {
    expect(resolveFfmpegExecutable('/custom/ffmpeg')).toBe('/custom/ffmpeg')
    expect(resolveYtDlpExecutable('/custom/yt-dlp')).toBe('/custom/yt-dlp')
  })
})
