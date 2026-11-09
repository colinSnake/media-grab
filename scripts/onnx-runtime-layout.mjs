import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, readdir, rm, stat } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import path from 'node:path'

async function digest(file) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}

/** Only call inside the newly generated, isolated deploy directory. */
export async function pruneDuplicateOnnxLibrary(directory, {
  platform = process.platform,
  node = process.execPath,
  inspect = (file) => execFileSync('/usr/bin/otool', ['-L', file], { encoding: 'utf8', timeout: 10_000 }),
  verify = (file) => execFileSync(node, ['-e', `require(${JSON.stringify(file)})`], { stdio: 'pipe', timeout: 15_000 }),
} = {}) {
  if (platform !== 'darwin') return 0
  const names = await readdir(directory)
  const canonical = path.join(directory, 'libonnxruntime.1.dylib')
  const binding = path.join(directory, 'onnxruntime_binding.node')
  const candidateNames = names.filter((name) => /^libonnxruntime\.\d+\.\d+\.\d+\.dylib$/.test(name))
  const inspected = names.filter((name) => name.endsWith('.node') || name.endsWith('.dylib'))
  let saved = 0
  for (const name of candidateNames) {
    const candidate = path.join(directory, name)
    if ((await lstat(canonical)).isSymbolicLink() || (await lstat(candidate)).isSymbolicLink()) continue
    const size = (await stat(candidate)).size
    if (size !== (await stat(canonical)).size || await digest(candidate) !== await digest(canonical)) continue
    // Do not remove a versioned library if ANY retained native file references it.
    const references = inspected.filter((other) => other !== name).map((other) => inspect(path.join(directory, other)))
    if (!references.some((text) => text.includes('@rpath/libonnxruntime.1.dylib')) || references.some((text) => text.includes(name))) continue
    await rm(candidate)
    saved += size
  }
  // A missing dependent dylib or incompatible native addon aborts staging, not the app.
  verify(binding)
  return saved
}
