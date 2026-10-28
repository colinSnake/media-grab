import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { chmod, copyFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const tools = JSON.parse(await readFile(path.join(root, 'scripts/ci-media-tools.json'), 'utf8'))
const target = `${process.platform}-${process.arch}`
const inputDirectory = process.env.MEDIA_GRAB_RELEASE_INPUTS_DIR
  ? path.resolve(process.env.MEDIA_GRAB_RELEASE_INPUTS_DIR)
  : path.join(root, '.release-tools', target)
const suffix = process.platform === 'win32' ? '.exe' : ''
const execFileAsync = promisify(execFile)

async function sha256(file) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}

function assertTarget() {
  if (!tools.ytDlp.assets[target]) throw new Error(`Unsupported release target: ${target}`)
  if (process.env.MEDIA_GRAB_EXPECTED_TARGET && process.env.MEDIA_GRAB_EXPECTED_TARGET !== target) {
    throw new Error(`Expected ${process.env.MEDIA_GRAB_EXPECTED_TARGET}, got ${target}`)
  }
}

async function download(url, output, expectedHash) {
  if (!/^[a-f0-9]{64}$/.test(expectedHash)) throw new Error(`Invalid SHA-256 for ${url}`)
  if (await sha256(output).catch(() => '') === expectedHash) return
  await mkdir(path.dirname(output), { recursive: true })
  const temporaryFile = `${output}.download`
  try {
    await execFileAsync(process.platform === 'win32' ? 'curl.exe' : 'curl', [
      '--fail', '--location', '--silent', '--show-error',
      '--retry', '4', '--retry-all-errors', '--retry-delay', '2',
      '--connect-timeout', '30', '--max-time', '300',
      '--output', temporaryFile, url,
    ], { timeout: 330_000, maxBuffer: 2 * 1024 * 1024 })
    const { size } = await stat(temporaryFile)
    if (size === 0 || size > 160 * 1024 * 1024) throw new Error(`Invalid download size (${size} bytes): ${url}`)
    const actualHash = await sha256(temporaryFile)
    if (actualHash !== expectedHash) throw new Error(`SHA-256 mismatch: ${url}\nExpected ${expectedHash}\nReceived ${actualHash}`)
    await rename(temporaryFile, output)
  } finally {
    await rm(temporaryFile, { force: true })
  }
  console.log(`Verified ${path.basename(output)}`)
}

async function downloadInputs() {
  assertTarget()
  const asset = tools.ytDlp.assets[target]
  const sourceUrl = `https://raw.githubusercontent.com/yt-dlp/yt-dlp/${tools.ytDlp.version}`
  await Promise.all([
    download(tools.ffmpeg.url, path.join(inputDirectory, 'sources/ffmpeg.tar.xz'), tools.ffmpeg.sha256),
    download(tools.lame.url, path.join(inputDirectory, 'sources/lame.tar.gz'), tools.lame.sha256),
    download(`https://github.com/yt-dlp/yt-dlp/releases/download/${tools.ytDlp.version}/${asset.name}`, path.join(inputDirectory, `yt-dlp${suffix}`), asset.sha256),
    download(`${sourceUrl}/LICENSE`, path.join(inputDirectory, 'yt-dlp-license.txt'), tools.ytDlp.licenseSha256),
    download(`${sourceUrl}/THIRD_PARTY_LICENSES.txt`, path.join(inputDirectory, 'yt-dlp-THIRD_PARTY_LICENSES.txt'), tools.ytDlp.noticesSha256),
  ])
  if (process.platform !== 'win32') await chmod(path.join(inputDirectory, `yt-dlp${suffix}`), 0o755)
  await mkdir(path.join(inputDirectory, 'build-records'), { recursive: true })
  await copyFile(path.join(root, 'scripts/ci-media-tools.json'), path.join(inputDirectory, 'build-records/source-inputs.json'))
}

async function finalizeInputs() {
  assertTarget()
  for (const [file, expectedHash] of [
    [`yt-dlp${suffix}`, tools.ytDlp.assets[target].sha256],
    ['yt-dlp-license.txt', tools.ytDlp.licenseSha256],
    ['yt-dlp-THIRD_PARTY_LICENSES.txt', tools.ytDlp.noticesSha256],
    ['sources/ffmpeg.tar.xz', tools.ffmpeg.sha256],
    ['sources/lame.tar.gz', tools.lame.sha256],
  ]) {
    if (await sha256(path.join(inputDirectory, file)) !== expectedHash) throw new Error(`Invalid cached input: ${file}`)
  }
  const inputs = {
    YT_DLP_BIN: `yt-dlp${suffix}`,
    YT_DLP_VERSION: tools.ytDlp.version,
    YT_DLP_SHA256: tools.ytDlp.assets[target].sha256,
    YT_DLP_LICENSE_FILE: 'yt-dlp-license.txt',
    YT_DLP_THIRD_PARTY_LICENSE_FILE: 'yt-dlp-THIRD_PARTY_LICENSES.txt',
    FFMPEG_BIN: `ffmpeg${suffix}`,
    FFMPEG_VERSION: tools.ffmpeg.version,
    FFMPEG_SHA256: await sha256(path.join(inputDirectory, `ffmpeg${suffix}`)),
    FFMPEG_LICENSE_FILE: 'ffmpeg-license.txt',
    LAME_LICENSE_FILE: 'lame-license.txt',
  }
  await writeFile(path.join(inputDirectory, 'release-inputs.json'), `${JSON.stringify(inputs, null, 2)}\n`)
  console.log(`Prepared verified tool inputs for ${target}`)
}

async function checkVersion() {
  const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
  const desktop = JSON.parse(await readFile(path.join(root, 'apps/desktop/src-tauri/tauri.conf.json'), 'utf8'))
  const cargo = await readFile(path.join(root, 'apps/desktop/src-tauri/Cargo.toml'), 'utf8')
  const cargoVersion = cargo.match(/^version\s*=\s*"([^"]+)"/m)?.[1]
  if (desktop.version !== manifest.version || cargoVersion !== manifest.version) {
    throw new Error('package.json, tauri.conf.json and Cargo.toml versions must match')
  }
  if (process.env.GITHUB_REF_TYPE === 'tag' && process.env.GITHUB_REF_NAME !== `v${manifest.version}`) {
    throw new Error(`Release tag must be v${manifest.version}, got ${process.env.GITHUB_REF_NAME}`)
  }
  console.log(`Release version: ${manifest.version}`)
}

async function filesIn(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = await Promise.all(entries.map(async (entry) => {
    const file = path.join(directory, entry.name)
    if (entry.isDirectory()) return filesIn(file)
    return entry.isFile() ? [file] : []
  }))
  return files.flat()
}

async function collectArtifacts() {
  assertTarget()
  const extensions = process.platform === 'darwin' ? ['.dmg'] : process.platform === 'win32' ? ['.exe'] : ['.deb', '.AppImage']
  const files = (await filesIn(path.join(root, 'apps/desktop/src-tauri/target/release/bundle')))
    .filter((file) => extensions.some((extension) => file.endsWith(extension)))
  for (const extension of extensions) {
    if (!files.some((file) => file.endsWith(extension))) throw new Error(`No ${extension} installer was built`)
  }
  const output = path.join(root, 'artifacts', target)
  await rm(output, { recursive: true, force: true })
  await mkdir(output, { recursive: true })
  for (const file of files) await copyFile(file, path.join(output, path.basename(file)))
  const toolsDirectory = path.join(root, 'apps/desktop/src-tauri/resources/media-tools', target)
  for (const name of ['tools-manifest.json', 'ffmpeg-LICENSE.txt', 'lame-LICENSE.txt', 'yt-dlp-LICENSE.txt', 'yt-dlp-THIRD_PARTY_LICENSES.txt']) {
    await copyFile(path.join(toolsDirectory, name), path.join(output, name))
  }
  await writeFile(path.join(output, 'build-info.json'), `${JSON.stringify({
    target,
    commit: process.env.GITHUB_SHA ?? null,
    node: process.version,
    toolSourcesArtifact: `MediaGrab-${target}-tool-sources`,
    signed: false,
  }, null, 2)}\n`)
  const names = (await readdir(output)).sort()
  const checksums = await Promise.all(names.map(async (name) => `${await sha256(path.join(output, name))}  ${name}`))
  await writeFile(path.join(output, 'SHA256SUMS'), `${checksums.join('\n')}\n`)
  console.log(`Collected installers: ${files.map((file) => path.basename(file)).join(', ')}`)
}

const commands = { download: downloadInputs, finalize: finalizeInputs, 'check-version': checkVersion, collect: collectArtifacts }
const command = commands[process.argv[2]]
if (!command) throw new Error('Usage: node scripts/ci-release-tools.mjs <download|finalize|check-version|collect>')
await command()
