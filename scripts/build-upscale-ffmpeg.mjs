/** Explicit offline source build. No downloads, system installation, or runtime staging. */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { openSync, closeSync } from 'node:fs'
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const sources = [
  { name: 'ffmpeg', archive: 'ffmpeg-8.1.tar.xz', url: 'https://ffmpeg.org/releases/ffmpeg-8.1.tar.xz', sha256: 'b072aed6871998cce9b36e7774033105ca29e33632be5b6347f3206898e0756a' },
  { name: 'x264', archive: 'x264-b35605ace3ddf7c1a5d67a2eb553f034aef41d55.tar.bz2', url: 'https://code.videolan.org/videolan/x264/-/archive/b35605ace3ddf7c1a5d67a2eb553f034aef41d55/x264-b35605ace3ddf7c1a5d67a2eb553f034aef41d55.tar.bz2', sha256: '6eeb82934e69fd51e043bd8c5b0d152839638d1ce7aa4eea65a3fedcf83ff224' },
  { name: 'pkgconf', archive: 'pkgconf-2.5.1.tar.xz', url: 'https://distfiles.ariadne.space/pkgconf/pkgconf-2.5.1.tar.xz', sha256: 'cd05c9589b9f86ecf044c10a2269822bc9eb001eced2582cfffd658b0a50c243' },
]
export function systemDylibsOnly(output) {
  const deps = output.split('\n').map((line) => line.match(/^\s+(.+?) \(compatibility version /)?.[1]).filter(Boolean)
  if (!deps.length || deps.some((dep) => !dep.startsWith('/usr/lib/') && !dep.startsWith('/System/Library/Frameworks/'))) throw new Error('Binary has missing, relative, or non-system dynamic dependencies')
  return deps
}
const sha256 = async (file) => createHash('sha256').update(await readFile(file)).digest('hex')
async function main() {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('Only native darwin-arm64 source builds are supported')
  const input = path.resolve(process.env.UPSCALER_BUILD_SOURCE_DIR ?? path.join(root, '.release-tools/upscale-source'))
  const jobs = Number(process.env.UPSCALER_BUILD_JOBS ?? 4)
  if (!Number.isInteger(jobs) || jobs < 1 || jobs > 8) throw new Error('UPSCALER_BUILD_JOBS must be 1–8')
  for (const source of sources) if (await sha256(path.join(input, source.archive)) !== source.sha256) throw new Error(`Missing/mismatched pinned source: ${source.archive}`)
  const parent = path.join(root, '.release-tools'); await mkdir(parent, { recursive: true })
  const work = await mkdtemp(path.join(parent, 'upscale-ffmpeg-'))
  const destination = path.join(work, 'output'), sdk = path.join(work, 'sdk')
  await mkdir(destination); await mkdir(path.join(sdk, 'lib/pkgconfig'), { recursive: true }); await mkdir(path.join(sdk, 'include'))
  const report = { createdAt: new Date().toISOString(), target: 'darwin-arm64', redistributionReviewed: false, sources, commands: [], binaries: {}, compiler: execFileSync('/usr/bin/clang', ['--version'], { encoding: 'utf8' }) }
  const log = openSync(path.join(work, 'build.log'), 'wx')
  const env = { ...process.env, PATH: '/usr/bin:/bin:/usr/sbin:/sbin', MACOSX_DEPLOYMENT_TARGET: '12.0', PKG_CONFIG_PATH: '', PKG_CONFIG_LIBDIR: path.join(sdk, 'lib/pkgconfig') }
  function run(executable, args, cwd) {
    report.commands.push({ executable, args, cwd: path.relative(work, cwd) })
    execFileSync(executable, args, { cwd, env, stdio: ['ignore', log, log] })
  }
  console.log(`Build workspace (preserved on failure): ${work}`)
  try {
    for (const source of sources) {
      const folder = path.join(work, source.name); await mkdir(folder)
      run('/usr/bin/tar', ['-xf', path.join(input, source.archive), '--strip-components=1', '-C', folder], work)
      await copyFile(path.join(input, source.archive), path.join(destination, source.archive))
    }
    console.log('Building source-local pkgconf (no make install)')
    const pkgconf = path.join(work, 'pkgconf'), x264 = path.join(work, 'x264'), ffmpeg = path.join(work, 'ffmpeg')
    run('./configure', ['--disable-shared', '--enable-static', '--disable-dependency-tracking'], pkgconf)
    run('/usr/bin/make', [`-j${jobs}`], pkgconf)
    console.log('Building static x264')
    run('./configure', ['--enable-static', '--disable-cli', '--disable-opencl', '--bit-depth=8', `--prefix=${sdk}`], x264)
    run('/usr/bin/make', [`-j${jobs}`], x264)
    await copyFile(path.join(x264, 'libx264.a'), path.join(sdk, 'lib/libx264.a'))
    for (const name of ['x264.h', 'x264_config.h']) await copyFile(path.join(x264, name), path.join(sdk, 'include', name))
    await copyFile(path.join(x264, 'x264.pc'), path.join(sdk, 'lib/pkgconfig/x264.pc'))
    console.log('Building minimal FFmpeg + independent FFprobe')
    run('./configure', [
      '--cc=/usr/bin/clang', `--pkg-config=${path.join(pkgconf, 'pkgconf')}`, '--pkg-config-flags=--static',
      '--disable-autodetect', '--disable-everything', '--disable-shared', '--enable-static', '--disable-doc', '--disable-network', '--disable-debug',
      '--enable-gpl', '--enable-libx264', '--enable-zlib', '--enable-ffmpeg', '--enable-ffprobe', '--disable-ffplay',
      '--enable-protocol=file,pipe', '--enable-demuxer=mov,image2pipe', '--enable-muxer=mp4,image2pipe,null,hash',
      '--enable-decoder=h264,aac,png', '--enable-encoder=libx264,png,wrapped_avframe,pcm_s16le', '--enable-parser=h264,aac,png',
      '--enable-filter=scale,format,setsar,aformat,aresample,null,anull', '--enable-bsf=aac_adtstoasc',
    ], ffmpeg)
    run('/usr/bin/make', [`-j${jobs}`, 'ffmpeg', 'ffprobe'], ffmpeg)
    for (const name of ['ffmpeg', 'ffprobe']) {
      const file = path.join(ffmpeg, name)
      const dylibs = systemDylibsOnly(execFileSync('/usr/bin/otool', ['-L', file], { encoding: 'utf8' }))
      const architecture = execFileSync('/usr/bin/lipo', ['-archs', file], { encoding: 'utf8' }).trim()
      if (architecture !== 'arm64') throw new Error(`Unexpected architecture: ${name}`)
      await copyFile(file, path.join(destination, name))
      report.binaries[name] = { sha256: await sha256(file), architecture, dylibs, version: execFileSync(file, ['-version'], { encoding: 'utf8' }).split('\n')[0] }
    }
    for (const [file, name] of [[path.join(ffmpeg, 'COPYING.GPLv2'), 'FFmpeg-LICENSE.txt'], [path.join(ffmpeg, 'LICENSE.md'), 'FFmpeg-LICENSE.md'], [path.join(x264, 'COPYING'), 'x264-LICENSE.txt'], [path.join(pkgconf, 'COPYING'), 'pkgconf-LICENSE.txt'], [path.join(ffmpeg, 'ffbuild/config.mak'), 'ffmpeg-config.mak'], [path.join(ffmpeg, 'config.h'), 'ffmpeg-config.h'], [path.join(x264, 'config.mak'), 'x264-config.mak']]) await copyFile(file, path.join(destination, name))
    report.finishedAt = new Date().toISOString()
    console.log(`Built binaries + corresponding source archives: ${destination}`)
    console.log('Not staged or redistribution-approved; run real pipeline/relocation tests before release preparation.')
  } catch (error) { report.failure = error instanceof Error ? error.stack : String(error); throw error }
  finally { closeSync(log); await writeFile(path.join(destination, 'build-provenance.json'), JSON.stringify(report, null, 2) + '\n') }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main()
