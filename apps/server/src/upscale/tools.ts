import { createHash } from 'node:crypto'
import { access, readFile, realpath, stat } from 'node:fs/promises'
import { constants } from 'node:fs'
import path from 'node:path'
import type { UpscaleCapability } from '@mediagrab/shared'
import { resolveBundledTool } from '../media-tools.js'
import { Processes } from './process.js'

export const limits = { maxSeconds: 600, maxFrames: 36000, maxPixels: 1920 * 1080, batch: 12, tile: 256 }
export const model = 'realesr-animevideov3-x2' as const
export interface Tools { ffmpeg: string; ffprobe: string; engine: string; models: string }
export async function sha256(file: string): Promise<string> {
  // Tool/model files are bounded by the manifest limit; video hashing uses streaming elsewhere.
  if ((await stat(file)).size > 256 * 1024 ** 2) throw new Error('依赖文件过大')
  return createHash('sha256').update(await readFile(file)).digest('hex')
}
export async function capability(signal = new AbortController().signal): Promise<{ capability: UpscaleCapability; tools?: Tools }> {
  const base: UpscaleCapability = { available: false, model, platform: `${process.platform}-${process.arch}`, limits }
  if (process.platform !== 'darwin' || process.arch !== 'arm64') return { capability: { ...base, reason: '首版仅支持 macOS Apple Silicon' } }
  try {
    const bundled = resolveBundledTool('ffmpeg')
    const root = await realpath(process.env.MEDIAGRAB_UPSCALE_DIR?.trim() || (bundled ? path.join(path.dirname(bundled), 'upscale') : '/nonexistent/mediagrab-upscale'))
    const manifest = JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8')) as { target: string; model: string; files: Record<string, string>; versions: Record<string, string> }
    if (manifest.target !== base.platform || manifest.model !== model) throw new Error('依赖 manifest 平台/模型不匹配')
    const names = ['ffmpeg', 'ffprobe', 'realesrgan-ncnn-vulkan', `models/${model}.bin`, `models/${model}.param`]
    const details: NonNullable<UpscaleCapability['tools']> = {}
    const processes = new Processes(signal)
    for (const name of names) {
      const file = path.join(root, name)
      const hash = await sha256(file)
      if (!/^[a-f0-9]{64}$/.test(manifest.files[name] ?? '') || hash !== manifest.files[name]) throw new Error(`依赖 SHA-256 不匹配: ${name}`)
      if (!name.startsWith('models/')) {
        await access(file, constants.X_OK)
        const arch = await processes.run('/usr/bin/lipo', ['-archs', file])
        if (!arch.split(/\s+/).includes('arm64')) throw new Error(`工具缺少 arm64 架构: ${name}`)
        const version = await processes.run(file, name === 'realesrgan-ncnn-vulkan' ? ['-h'] : ['-version']).catch((e: unknown) => {
          // ncnn's help exits nonzero; pin its binary hash and release identity instead.
          if (name === 'realesrgan-ncnn-vulkan' && !signal.aborted) return manifest.versions[name] ?? ''
          throw e
        })
        if (!manifest.versions[name] || !version.includes(manifest.versions[name]!)) throw new Error(`工具版本不匹配: ${name}`)
      }
      details[name] = { path: file, sha256: hash, version: manifest.versions[name] ?? model }
    }
    const ffmpeg = path.join(root, 'ffmpeg')
    const encoders = await processes.run(ffmpeg, ['-hide_banner', '-encoders'])
    const decoders = await processes.run(ffmpeg, ['-hide_banner', '-decoders'])
    const demuxers = await processes.run(ffmpeg, ['-hide_banner', '-demuxers'])
    if (!/\blibx264\b/.test(encoders) || !/\bpng\b/.test(encoders) || !/\bh264\b/.test(decoders) || !/\baac\b/.test(decoders) || !/\bpng\b/.test(decoders) || !/\bmov\b/.test(demuxers) || !/\bimage2pipe\b/.test(demuxers)) throw new Error('FFmpeg 缺少 H.264/AAC/PNG/MP4/image2pipe 处理能力')
    return { capability: { ...base, available: true, tools: details }, tools: { ffmpeg: path.join(root, 'ffmpeg'), ffprobe: path.join(root, 'ffprobe'), engine: path.join(root, 'realesrgan-ncnn-vulkan'), models: path.join(root, 'models') } }
  } catch (e) { return { capability: { ...base, reason: e instanceof Error ? e.message : String(e) } } }
}
