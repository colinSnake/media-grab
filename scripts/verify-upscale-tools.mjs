import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { access, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { systemDylibsOnly } from './build-upscale-ffmpeg.mjs'
import { bundleUpscaleLayout } from './upscale-release-support.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
let app
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--app') { app = args[++i]; if (!app) throw new Error('--app needs an absolute .app path') }
  else if (!['--required', '--require-signatures'].includes(args[i])) throw new Error(`Unknown argument: ${args[i]}`)
}
const target = `${process.platform}-${process.arch}`
if (target !== 'darwin-arm64') {
  if (app) throw new Error('macOS Apple Silicon bundle verification requires native darwin-arm64')
  console.log(`Upscale intentionally unavailable on ${target}`); process.exit(0)
}
const layout = app ? bundleUpscaleLayout(app, target) : {
  directory: path.join(root, 'apps/desktop/src-tauri/resources/media-tools', target, 'upscale'), node: process.execPath,
  capabilityModule: path.join(root, 'apps/server/dist/upscale/tools.js'), supervisor: path.join(root, 'apps/server/dist/upscale/supervise.mjs'),
  mediaTools: path.join(root, 'apps/desktop/src-tauri/resources/media-tools'),
}
const { directory } = layout
try { await access(path.join(directory, 'manifest.json')) } catch {
  if (app || args.includes('--required')) throw new Error('Release requires reviewed offline upscale dependencies; run prepare:upscale-tools with explicit sources. No automatic download is performed.')
  console.log('Upscale dependencies not staged; desktop capability will report unavailable.'); process.exit(0)
}
const manifest = JSON.parse(await readFile(path.join(directory, 'manifest.json'), 'utf8'))
if (manifest.developmentOnly || manifest.redistributionReviewed !== true) throw new Error('Development-only or unreviewed dependencies cannot enter a release bundle')
for (const name of ['Real-ESRGAN-LICENSE.txt', 'Real-ESRGAN-ncnn-vulkan-LICENSE.txt', 'FFmpeg-LICENSE.txt', 'x264-LICENSE.txt', 'FFmpeg-SOURCE-NOTICE.txt', 'THIRD_PARTY_NOTICES.txt', 'provenance.json']) {
  const data = await readFile(path.join(directory, name))
  if (!data.length || createHash('sha256').update(data).digest('hex') !== manifest.files[name]) throw new Error(`Missing/mismatched release notice: ${name}`)
}
await access(layout.node); await access(layout.capabilityModule); await access(layout.supervisor)
for (const name of ['ffmpeg', 'ffprobe', 'realesrgan-ncnn-vulkan']) {
  const file = path.join(directory, name)
  systemDylibsOnly(execFileSync('/usr/bin/otool', ['-L', file], { encoding: 'utf8' }))
  if (args.includes('--require-signatures')) execFileSync('/usr/bin/codesign', ['--verify', '--strict', '--verbose=2', file], { stdio: 'inherit' })
}
if (app && args.includes('--require-signatures')) execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', app], { stdio: 'inherit' })
const code = `const {capability}=await import(${JSON.stringify(pathToFileURL(layout.capabilityModule).href)});const result=await capability();console.log(JSON.stringify(result.capability));if(!result.capability.available)process.exitCode=1;`
// For an actual .app, exercise its bundled Node + core, without launching the app,
// opening a listening port, loading a model, or relying on developer PATH.
const output = execFileSync(layout.node, ['--input-type=module', '-e', code], {
  cwd: path.dirname(layout.capabilityModule), encoding: 'utf8', timeout: 30000,
  env: { ...process.env, PATH: '/usr/bin:/bin:/usr/sbin:/sbin', NODE_PATH: undefined, NODE_OPTIONS: undefined, MEDIAGRAB_CORE_TOKEN: undefined, MEDIA_TOOLS_DIR: layout.mediaTools, MEDIAGRAB_UPSCALE_DIR: directory },
})
const result = JSON.parse(output)
if (!result.available) throw new Error(result.reason)
console.log(JSON.stringify({ application: app ?? null, runtime: layout.node, capability: result, note: 'Resource verification only; GUI and notarization acceptance are separate.' }, null, 2))
