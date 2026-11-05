import { access, cp, lstat, mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
if (process.platform !== 'darwin') process.exit(0)
const bundle = path.join(root, 'apps/desktop/src-tauri/target/release/bundle')
const app = path.join(bundle, 'macos/MediaGrab.app')
const output = path.join(bundle, 'dmg/MediaGrab_0.1.1_aarch64_upscale-test.dmg')
await access(app)
try { await lstat(output); throw new Error(`DMG 已存在，拒绝覆盖旧安装包: ${output}`) }
catch (error) { if (error.code !== 'ENOENT') throw error }
await mkdir(path.dirname(output), { recursive: true })
const temporary = await mkdtemp(path.join(os.tmpdir(), 'mediagrab-dmg-source-'))
try {
  await cp(app, path.join(temporary, 'MediaGrab.app'), { recursive: true })
  await symlink('/Applications', path.join(temporary, 'Applications'))
  execFileSync('hdiutil', ['create', '-volname', 'MediaGrab', '-srcfolder', temporary, '-format', 'UDZO', output], { stdio: 'inherit' })
  execFileSync('hdiutil', ['verify', output], { stdio: 'inherit' })
  console.log(`已创建并校验 macOS DMG: ${path.relative(root, output)}`)
} catch (error) {
  await rm(output, { force: true })
  throw error
} finally {
  await rm(temporary, { recursive: true, force: true })
}
