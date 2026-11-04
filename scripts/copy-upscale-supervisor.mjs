import { copyFile, mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
const directory = new URL('../apps/server/dist/upscale/', import.meta.url)
await mkdir(directory, { recursive: true })
await copyFile(new URL('../apps/server/src/upscale/supervise.mjs', import.meta.url), new URL('supervise.mjs', directory))
console.log('Copied parent-death tool supervisor into', fileURLToPath(directory))
