import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** 从起始目录向上查找 monorepo 根（以 pnpm-workspace.yaml 为标记） */
export function findRepoRoot(startDir: string): string | undefined {
  let dir = path.resolve(startDir)
  for (;;) {
    if (existsSync(path.join(dir, 'pnpm-workspace.yaml'))) return dir
    const parent = path.dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}

/**
 * 定位前端构建产物目录。
 *
 * 优先 WEB_DIST 环境变量；否则从**模块自身位置**向上找仓库根再拼 `apps/web/dist`。
 * 这样无论从 `src`（tsx）还是 `dist`（node）运行、也不管 cwd 在哪，结果都一致 ——
 * 避免依赖 cwd 或可执行文件位置的脆弱猜测（见 docs/tech-design.md ADR-9）。
 */
export function resolveWebDist(
  moduleDir: string = path.dirname(fileURLToPath(import.meta.url)),
): string {
  const override = process.env.WEB_DIST
  if (override !== undefined && override.trim() !== '') return path.resolve(override)
  const root = findRepoRoot(moduleDir)
  return root !== undefined
    ? path.join(root, 'apps', 'web', 'dist')
    : path.resolve(moduleDir, '..', '..', 'web', 'dist')
}

/**
 * 本地数据目录（SQLite 等）。
 *
 * 与 `web/dist` 同样的定位策略：优先环境变量 `DATA_DIR`，否则从模块位置向上找仓库根。
 * 默认落在 `data/`（已进 .gitignore），避免把库写进 dist 或用户主目录。
 */
export function resolveDataDir(
  moduleDir: string = path.dirname(fileURLToPath(import.meta.url)),
): string {
  const override = process.env.DATA_DIR
  if (override !== undefined && override.trim() !== '') return path.resolve(override)
  const root = findRepoRoot(moduleDir)
  return root !== undefined ? path.join(root, 'data') : path.resolve(moduleDir, '..', '..', 'data')
}

/** SQLite 文件路径；`DB_PATH` 可覆盖（测试与多实例用） */
export function resolveDbPath(
  moduleDir: string = path.dirname(fileURLToPath(import.meta.url)),
): string {
  const override = process.env.DB_PATH
  if (override !== undefined && override.trim() !== '') return path.resolve(override)
  return path.join(resolveDataDir(moduleDir), 'mediaGrab.db')
}

/**
 * 解析用户配置的下载目录。
 *
 * 默认值使用 `~/Downloads/mediaGrab`，由本地核心展开到当前用户目录；
 * 绝对路径保持不变，旧的相对路径继续相对仓库根目录解析以保持兼容。
 */
export function resolveDownloadDir(
  savePath: string,
  moduleDir: string = path.dirname(fileURLToPath(import.meta.url)),
): string {
  if (savePath === '~' || savePath.startsWith('~/')) {
    return path.resolve(os.homedir(), savePath === '~' ? '.' : savePath.slice(2))
  }
  const root = findRepoRoot(moduleDir)
  const base = root ?? path.resolve(moduleDir, '..', '..')
  return path.resolve(base, savePath)
}
