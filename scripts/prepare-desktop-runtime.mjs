import { chmod, cp, mkdir, mkdtemp, readdir, readlink, rm, symlink, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const runtimeDir = path.join(root, 'apps', 'desktop', 'src-tauri', 'resources', 'core')
const temporaryDir = await mkdtemp(path.join(os.tmpdir(), 'mediagrab-deploy-'))
const deployDir = path.join(temporaryDir, 'server')
const nodeName = process.platform === 'win32' ? 'node.exe' : 'node'
const nodeSource = process.env.MEDIA_GRAB_NODE_BIN?.trim() || process.execPath

function run(command, args, env = {}) {
  if (command === 'pnpm' && process.platform === 'win32') {
    const pnpmExecutable = process.env.npm_execpath
    if (pnpmExecutable) {
      const isJavaScriptEntrypoint = /\.(?:c?js)$/i.test(pnpmExecutable)
      command = isJavaScriptEntrypoint ? process.execPath : pnpmExecutable
      if (isJavaScriptEntrypoint) args = [pnpmExecutable, ...args]
    }
  }
  execFileSync(command, args, { cwd: root, stdio: 'inherit', env: { ...process.env, ...env } })
}

function pnpmMajorVersion() {
  const version = execFileSync('pnpm', ['--version'], { cwd: root, encoding: 'utf8' }).trim()
  const major = Number.parseInt(version.split('.', 1)[0] ?? '', 10)
  if (!Number.isInteger(major)) throw new Error(`无法识别 pnpm 版本: ${version}`)
  return major
}

async function normalizeDeployLinks(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name)
    if (entry.isSymbolicLink()) {
      const rawTarget = await readlink(entryPath)
      const target = path.resolve(path.dirname(entryPath), rawTarget)
      await rm(entryPath, { force: true })
      if (target.startsWith(`${deployDir}${path.sep}`)) {
        await symlink(path.relative(path.dirname(entryPath), target), entryPath)
      } else {
        await cp(target, entryPath, { recursive: true, dereference: true })
      }
      continue
    }
    if (entry.isDirectory()) await normalizeDeployLinks(entryPath)
  }
}

async function removeMatchingFiles(directory, predicate) {
  const entries = await readdir(directory, { withFileTypes: true })
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      if (/^(test|tests|__tests__|examples?|docs)$/i.test(entry.name)) {
        await rm(entryPath, { recursive: true, force: true })
        continue
      }
      await removeMatchingFiles(entryPath, predicate)
      continue
    }
    if (predicate(entry.name, entryPath)) await rm(entryPath, { force: true })
  }
}

console.log('构建 shared 和 server ...')
run('pnpm', ['build:shared'])
run('pnpm', ['build:server'])
run('pnpm', ['build:web'])

await mkdir(runtimeDir, { recursive: true })

console.log('收集 server 生产依赖 ...')
// pnpm 10 requires injected workspace packages unless --legacy is explicit.
// pnpm 12's legacy deploy path can omit transitive dependencies of workspace
// packages, so use the default deploy implementation there. The release deploy
// is deliberately flattened to a self-contained hoisted runtime.
const deployArgs = [
  '--filter',
  '@mediagrab/server',
  'deploy',
  deployDir,
  '--prod',
  '--config.node-linker=hoisted',
]
if (pnpmMajorVersion() < 12) deployArgs.splice(5, 0, '--legacy')
run('pnpm', deployArgs)

// pnpm deploy keeps a self-link for the workspace package. It is useless at
// runtime and points outside the deploy directory, so remove it before
// dereferencing the remaining dependency links into the application bundle.
await rm(path.join(deployDir, 'node_modules', '@mediagrab', 'server'), { force: true })
await rm(path.join(deployDir, 'node_modules', '.pnpm', 'node_modules', '@mediagrab', 'server'), { force: true })
await normalizeDeployLinks(deployDir)

const deployedEntry = path.join(deployDir, 'dist', 'index.js')
const webDist = path.join(root, 'apps', 'web', 'dist')
if (!(await import('node:fs').then(({ existsSync }) => existsSync(deployedEntry)))) {
  throw new Error(`server deploy 未生成入口文件: ${deployedEntry}`)
}
try {
  for (const entry of await readdir(runtimeDir)) {
    if (entry !== 'README.md') await rm(path.join(runtimeDir, entry), { recursive: true, force: true })
  }
  for (const entry of await (await import('node:fs/promises')).readdir(deployDir)) {
    await cp(path.join(deployDir, entry), path.join(runtimeDir, entry), { recursive: true, dereference: true })
  }
  for (const entry of ['src', 'scripts', 'download', 'testing', 'tsconfig.json', 'vitest.config.ts']) {
    await rm(path.join(runtimeDir, entry), { recursive: true, force: true })
  }
  await rm(path.join(runtimeDir, 'dist', 'testing'), { recursive: true, force: true })
  await removeMatchingFiles(path.join(runtimeDir, 'dist'), (name) => name.endsWith('.test.js'))
  const sharedPackage = path.join(runtimeDir, 'node_modules', '@mediagrab', 'shared')
  await rm(sharedPackage, { recursive: true, force: true })
  await mkdir(sharedPackage, { recursive: true })
  await cp(path.join(root, 'packages', 'shared', 'dist'), path.join(sharedPackage, 'dist'), { recursive: true })
  await cp(path.join(root, 'packages', 'shared', 'package.json'), path.join(sharedPackage, 'package.json'))
  if (!(await import('node:fs').then(({ existsSync }) => existsSync(path.join(runtimeDir, 'node_modules', 'zod', 'package.json'))))) {
    throw new Error('桌面核心缺少 shared 的生产依赖 zod，请检查 pnpm deploy 模式。')
  }
  await removeMatchingFiles(path.join(sharedPackage, 'dist'), (name) => name.endsWith('.d.ts') || name.endsWith('.map'))
  await cp(webDist, path.join(runtimeDir, 'web'), { recursive: true })
  await cp(nodeSource, path.join(runtimeDir, nodeName))
  if (process.platform !== 'win32') await chmod(path.join(runtimeDir, nodeName), 0o755)
  await removeMatchingFiles(path.join(runtimeDir, 'node_modules'), (name) =>
    /\.(?:d\.ts|map)$/.test(name) || /^(?:readme|changelog|changes|history)(?:\.|$)/i.test(name),
  )
  await rm(path.join(runtimeDir, 'node_modules', '.modules.yaml'), { force: true })

  await writeFile(
    path.join(runtimeDir, 'package.json'),
    `${JSON.stringify({ name: 'mediagrab-core-runtime', private: true, type: 'module' }, null, 2)}\n`,
  )

  await writeFile(
    path.join(runtimeDir, 'runtime.json'),
    `${JSON.stringify({ node: process.version, platform: process.platform, arch: process.arch, generatedOn: new Date().toISOString() }, null, 2)}\n`,
  )
} finally {
  await rm(temporaryDir, { recursive: true, force: true })
}

console.log(`已准备 ${process.platform}-${process.arch} 桌面核心: ${path.relative(root, runtimeDir)}`)
