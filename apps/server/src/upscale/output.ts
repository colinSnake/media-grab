import { mkdtemp, writeFile, link, rm } from 'node:fs/promises'
import path from 'node:path'

/** Exercise the actual no-overwrite publication primitive before any inference. */
export async function checkAtomicOutput(directory: string): Promise<void> {
  const work = await mkdtemp(path.join(directory, '.mediagrab-upscale-check-'))
  try {
    const source = path.join(work, 'source')
    await writeFile(source, 'atomic output check', { flag: 'wx', mode: 0o600 })
    await link(source, path.join(work, 'linked'))
  } catch (cause) {
    throw new Error('输出目录不支持安全的无覆盖硬链接提交，或不可写；请选择其它本地目录', { cause })
  } finally {
    await rm(work, { recursive: true, force: true })
  }
}
