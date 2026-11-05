import assert from 'node:assert/strict'
import { test } from 'node:test'
import { sources, systemDylibsOnly } from './build-upscale-ffmpeg.mjs'

test('release dynamic dependencies are a system allowlist, not a machine-path denylist', () => {
  const dependency = (name) => `tool:\n\t${name} (compatibility version 1.0.0, current version 1.0.0)\n`
  assert.equal(systemDylibsOnly(dependency('/usr/lib/libSystem.B.dylib')).length, 1)
  assert.equal(systemDylibsOnly(dependency('/System/Library/Frameworks/Metal.framework/Versions/A/Metal')).length, 1)
  for (const name of ['/opt/homebrew/lib/libx264.dylib', '/private/tmp/build/libx264.dylib', '/Volumes/External/libx264.dylib', '@rpath/libx264.dylib', '@loader_path/libx264.dylib']) {
    assert.throws(() => systemDylibsOnly(dependency(name)), /non-system/)
  }
  assert.throws(() => systemDylibsOnly('tool:\n'), /missing/)
})
test('offline FFmpeg builder pins every source archive', () => {
  assert.equal(sources.length, 3)
  for (const source of sources) { assert.match(source.sha256, /^[a-f0-9]{64}$/); assert.ok(source.url.startsWith('https://')) }
})

test('ordinary desktop build refreshes and verifies its packaged server runtime', async () => {
  const { readFile } = await import('node:fs/promises')
  const { fileURLToPath } = await import('node:url')
  const path = await import('node:path')
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
  const build = manifest.scripts['build:desktop']
  assert.match(build, /pnpm prepare:desktop-runtime/)
  assert.match(build, /pnpm verify:desktop-runtime/)
  assert.match(build, /create-macos-dmg\.mjs/)
  assert.ok(build.indexOf('pnpm prepare:desktop-runtime') < build.indexOf('tauri build --bundles app'))
  assert.ok(build.indexOf('pnpm verify:desktop-runtime') < build.indexOf('tauri build --bundles app'))
})

test('development upscale opt-in cannot be combined with release verification', async () => {
  const { readFile } = await import('node:fs/promises')
  const { fileURLToPath } = await import('node:url')
  const path = await import('node:path')
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const verifier = await readFile(path.join(root, 'scripts/verify-upscale-tools.mjs'), 'utf8')
  assert.match(verifier, /allowDevelopment && \(args\.includes\('--required'\) \|\| args\.includes\('--require-signatures'\)\)/)
  assert.match(verifier, /developmentOnly && !allowDevelopment/)
})

test('app verification resolves both Tauri resource layouts without using developer directories', async () => {
  const { bundleUpscaleLayout } = await import('./upscale-release-support.mjs')
  const { mkdtemp, mkdir, rm } = await import('node:fs/promises')
  const os = await import('node:os'), path = await import('node:path')
  const root = await mkdtemp(path.join(os.tmpdir(), 'upscale-layout-'))
  try {
    const app = path.join(root, 'MediaGrab.app'), resources = path.join(app, 'Contents/Resources')
    assert.throws(() => bundleUpscaleLayout('relative.app'), /absolute/)
    assert.throws(() => bundleUpscaleLayout(root), /\.app/)
    const flattened = bundleUpscaleLayout(app)
    assert.equal(flattened.node, path.join(resources, 'core/node'))
    assert.equal(flattened.directory, path.join(resources, 'media-tools/darwin-arm64/upscale'))
    await mkdir(path.join(resources, 'resources/core'), { recursive: true })
    const nested = bundleUpscaleLayout(app)
    assert.equal(nested.node, path.join(resources, 'resources/core/node'))
    assert.equal(nested.supervisor, path.join(resources, 'resources/core/dist/upscale/supervise.mjs'))
  } finally { await rm(root, { recursive: true, force: true }) }
})

// Copy only the scripts into an owned fixture: even a regression must never stage
// anything into the real repository's required runtime directory.
async function stagingFixture(run) {
  const { mkdtemp, mkdir, copyFile, writeFile, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os'), path = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const { spawnSync } = await import('node:child_process')
  const root = await mkdtemp(path.join(tmpdir(), 'upscale-staging-'))
  try {
    await mkdir(path.join(root, 'scripts'))
    for (const name of ['prepare-upscale-tools.mjs', 'build-upscale-ffmpeg.mjs']) {
      await copyFile(fileURLToPath(new URL(name, import.meta.url)), path.join(root, 'scripts', name))
    }
    const source = path.join(root, 'source'), binary = path.join(root, 'untrusted-ffmpeg')
    await mkdir(source)
    const marker = path.join(root, 'executed')
    await writeFile(binary, `#!/bin/sh\ntouch "${marker}"\n`, { mode: 0o755 })
    const review = path.join(root, 'review.json'), license = path.join(root, 'license')
    await writeFile(review, JSON.stringify({
      schemaVersion: 1, redistributionReviewed: true, target: 'darwin-arm64', decision: 'approved',
      reviewedBy: 'fixture reviewer', reviewedAt: '2026-11-04', evidence: ['fixture review record'],
      engineSource: 'fixture', modelSource: 'fixture', ffmpegSource: 'fixture', ffprobeSource: 'fixture',
      files: {
        ffmpeg: '0'.repeat(64), ffprobe: '0'.repeat(64), 'realesrgan-ncnn-vulkan': '0'.repeat(64),
        'models/realesr-animevideov3-x2.bin': '0'.repeat(64), 'models/realesr-animevideov3-x2.param': '0'.repeat(64),
      },
    }))
    const destination = path.join(root, 'apps/desktop/src-tauri/resources/media-tools/darwin-arm64/upscale')
    const invoke = (args = []) => spawnSync(process.execPath, [path.join(root, 'scripts/prepare-upscale-tools.mjs'), ...args], {
      encoding: 'utf8', timeout: 10000,
      env: { ...process.env, UPSCALER_SOURCE_DIR: source, UPSCALER_FFMPEG: binary, UPSCALER_FFPROBE: binary, UPSCALER_REVIEW_MANIFEST: review, UPSCALER_LICENSE_DIR: license, UPSCALER_DEVELOPMENT_DESTINATION: undefined, UPSCALER_SIGN_IDENTITY: undefined },
    })
    await run({ root, destination, marker, review, invoke, writeFile, mkdir, path })
  } finally { await rm(root, { recursive: true, force: true }) }
}
const nativeStaging = { skip: process.platform !== 'darwin' || process.arch !== 'arm64' }
test('release staging rejects unreviewed hashes before executing binaries or creating runtime inputs', nativeStaging, async () => {
  const { existsSync } = await import('node:fs')
  await stagingFixture(async ({ destination, marker, invoke }) => {
    const result = invoke()
    assert.equal(result.status, 1)
    assert.match(result.stderr, /Unreviewed input SHA-256: ffmpeg/)
    assert.equal(existsSync(marker), false)
    assert.equal(existsSync(destination), false)
  })
})
test('release staging rejects incomplete review evidence before executing binaries', nativeStaging, async () => {
  const { existsSync } = await import('node:fs'), { readFile } = await import('node:fs/promises')
  await stagingFixture(async ({ destination, marker, review, invoke, writeFile }) => {
    const value = JSON.parse(await readFile(review, 'utf8'))
    delete value.reviewedBy
    await writeFile(review, JSON.stringify(value))
    const result = invoke()
    assert.equal(result.status, 1)
    assert.match(result.stderr, /Incomplete provenance \/ redistribution review manifest/)
    assert.equal(existsSync(marker), false)
    assert.equal(existsSync(destination), false)
  })
})
test('release staging preserves even partial existing runtime inputs', nativeStaging, async () => {
  const { existsSync } = await import('node:fs'), { readFile } = await import('node:fs/promises')
  await stagingFixture(async ({ destination, marker, invoke, writeFile, mkdir, path }) => {
    await mkdir(destination, { recursive: true })
    const sentinel = path.join(destination, 'keep.txt'); await writeFile(sentinel, 'required runtime')
    const result = invoke()
    assert.equal(result.status, 1); assert.match(result.stderr, /Staging already exists/)
    assert.equal(await readFile(sentinel, 'utf8'), 'required runtime')
    assert.equal(existsSync(marker), false)
  })
})
test('staging rejects misspelled modes instead of silently preparing release resources', nativeStaging, async () => {
  const { existsSync } = await import('node:fs')
  await stagingFixture(async ({ destination, marker, invoke }) => {
    const result = invoke(['--developmnt'])
    assert.equal(result.status, 1); assert.match(result.stderr, /Usage:/)
    assert.equal(existsSync(marker), false); assert.equal(existsSync(destination), false)
  })
})
