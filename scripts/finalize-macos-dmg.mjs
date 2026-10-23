import { execFile } from 'node:child_process'
import { mkdtemp, readdir, rename, rm, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const bundleDir = path.join(root, 'apps', 'desktop', 'src-tauri', 'target', 'release', 'bundle')
const execFileAsync = promisify(execFile)

async function findDiskImages(directory) {
  const entries = await readdir(directory, { withFileTypes: true }).catch((error) => {
    if (error.code === 'ENOENT') return []
    throw error
  })
  const files = await Promise.all(entries.map(async (entry) => {
    const file = path.join(directory, entry.name)
    if (entry.isDirectory()) return findDiskImages(file)
    return entry.isFile() && file.endsWith('.dmg') ? [file] : []
  }))
  return files.flat()
}

if (process.platform === 'darwin') {
  // Tauri leaves a temporary read/write source image under bundle/macos while
  // producing the distributable DMG. Only the final images in bundle/dmg are
  // safe to post-process; touching the temporary source can make hdiutil fail
  // with "Resource temporarily unavailable" while it is still mounted.
  const images = await findDiskImages(path.join(bundleDir, 'dmg'))
  if (images.length === 0) throw new Error(`找不到待清理的 macOS DMG: ${bundleDir}`)

  for (const image of images) {
    const temporaryDir = await mkdtemp(path.join(os.tmpdir(), 'mediagrab-dmg-'))
    const writableImage = path.join(temporaryDir, 'writable.dmg')
    const fixedImage = path.join(temporaryDir, path.basename(image))
    const mountPoint = path.join(temporaryDir, 'mount')
    let attached = false

    try {
      await execFileAsync('hdiutil', ['convert', image, '-format', 'UDRW', '-o', writableImage], { timeout: 120_000 })
      await (await import('node:fs/promises')).mkdir(mountPoint)
      await execFileAsync('hdiutil', [
        'attach', writableImage, '-readwrite', '-noverify', '-noautoopen', '-nobrowse', '-mountpoint', mountPoint,
      ], { timeout: 60_000 })
      attached = true

      await rm(path.join(mountPoint, '.VolumeIcon.icns'), { force: true })
      await execFileAsync('SetFile', ['-a', 'c', mountPoint], { timeout: 10_000 })
      await execFileAsync('hdiutil', ['detach', mountPoint], { timeout: 60_000 })
      attached = false

      await execFileAsync('hdiutil', ['convert', writableImage, '-format', 'UDZO', '-imagekey', 'zlib-level=9', '-o', fixedImage], { timeout: 180_000 })
      await execFileAsync('hdiutil', ['verify', fixedImage], { timeout: 120_000 })

      const verificationMount = path.join(temporaryDir, 'verification')
      await (await import('node:fs/promises')).mkdir(verificationMount)
      await execFileAsync('hdiutil', [
        'attach', fixedImage, '-readonly', '-noverify', '-noautoopen', '-nobrowse', '-mountpoint', verificationMount,
      ], { timeout: 60_000 })
      try {
        if (await stat(path.join(verificationMount, '.VolumeIcon.icns')).then(() => true).catch(() => false)) {
          throw new Error(`DMG 仍包含 Finder 隐藏文件: ${image}`)
        }
      } finally {
        await execFileAsync('hdiutil', ['detach', verificationMount], { timeout: 60_000 })
      }

      const backupImage = `${image}.original`
      await rename(image, backupImage)
      try {
        await rename(fixedImage, image)
      } catch (error) {
        await rename(backupImage, image)
        throw error
      }
      await rm(backupImage)
      console.log(`已移除 DMG 中的隐藏卷图标文件: ${path.relative(root, image)}`)
    } finally {
      if (attached) await execFileAsync('hdiutil', ['detach', mountPoint], { timeout: 60_000 }).catch(() => {})
      await rm(temporaryDir, { recursive: true, force: true })
    }
  }
}
