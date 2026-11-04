import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer } from 'node:net'
import path from 'node:path'
import { assertPortsFree, developmentToolDirectory, isolatedDesktopEnvironment } from './upscale-dev-support.mjs'
import { main } from './dev-upscale.mjs'

test('desktop test environment overrides production data/token without mutating parent environment', () => {
  const parent = { DATA_DIR: '/real/user/data', DB_PATH: '/real/user/data/prod.db', MEDIAGRAB_CORE_TOKEN: 'old-secret', PORT: '9999' }
  const directory = path.resolve('/tmp/upscale-test'), tools = path.resolve('/tmp/upscale-tools')
  const env = isolatedDesktopEnvironment(directory, tools, parent)
  assert.equal(env.DATA_DIR, directory); assert.equal(env.DB_PATH, path.join(directory, 'mediaGrab.db'))
  assert.equal(env.MEDIAGRAB_DESKTOP_TEST_DATA_DIR, directory); assert.equal(env.MEDIAGRAB_UPSCALE_DIR, tools)
  assert.match(env.MEDIAGRAB_CORE_TOKEN, /^[a-f0-9]{64}$/); assert.equal(env.MEDIAGRAB_DESKTOP_CORE, '1')
  assert.equal(env.PORT, '9070'); assert.equal(parent.DB_PATH, '/real/user/data/prod.db'); assert.equal(parent.MEDIAGRAB_CORE_TOKEN, 'old-secret')
  assert.throws(() => isolatedDesktopEnvironment('relative', tools), /绝对/)
})
test('explicit dependency roots are absolute and do not use the reference project', () => {
  assert.throws(() => developmentToolDirectory({ MEDIAGRAB_UPSCALE_DIR: './tools' }), /绝对/)
  assert.equal(developmentToolDirectory({ MEDIAGRAB_UPSCALE_DIR: '/tmp/local-tools' }), '/tmp/local-tools')
  assert.ok(developmentToolDirectory({}).endsWith(path.join('.release-tools', 'upscale-offline-test')))
})
test('occupied ports fail preflight without stopping their owner', async () => {
  const server = createServer((socket) => socket.end())
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    await assert.rejects(assertPortsFree([server.address().port]), /已被占用/)
    assert.equal(server.listening, true)
  } finally { await new Promise((resolve) => server.close(resolve)) }
})
test('desktop entry requires one explicit check/launch mode, never starts by import or invalid invocation', async () => {
  await assert.rejects(main([]), /仅检查/)
  await assert.rejects(main(['--check', '--launch']), /仅检查/)
})
test('root pnpm dev delegates to the documented desktop development entry', async () => {
  const { readFile } = await import('node:fs/promises')
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(manifest.scripts.dev, 'pnpm dev:desktop')
})
