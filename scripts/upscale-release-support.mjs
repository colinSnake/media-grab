import path from 'node:path'
import { existsSync } from 'node:fs'

/** Resolve actual installed-resource layouts, not paths from the development cwd. */
export function bundleUpscaleLayout(app, target = 'darwin-arm64') {
  if (!path.isAbsolute(app) || !app.endsWith('.app')) throw new Error('--app must be an absolute .app path')
  const resources = path.join(app, 'Contents/Resources')
  const prefix = existsSync(path.join(resources, 'resources/core')) ? path.join(resources, 'resources') : resources
  const core = path.join(prefix, 'core'), mediaTools = path.join(prefix, 'media-tools')
  return { directory: path.join(mediaTools, target, 'upscale'), node: path.join(core, 'node'), capabilityModule: path.join(core, 'dist/upscale/tools.js'), supervisor: path.join(core, 'dist/upscale/supervise.mjs'), mediaTools }
}
