/**
 * 数据库 schema 定义（SQLite，node:sqlite 同步 API）。
 *
 * 版本策略：用 SQLite 自带的 `PRAGMA user_version` 记录结构版本（见 store/db.ts）。
 * 所有建表语句都是 `CREATE TABLE IF NOT EXISTS`，所以从任意旧版本重跑迁移都是幂等的，
 * 不需要为每一步单独写升级脚本；只有**破坏性**改动才需要另写迁移逻辑。
 */

/**
 * 当前 schema 版本。
 * 每次调整表结构（新增/删除/改名列）都必须 +1，并在 db.ts 的迁移里补上对应步骤。
 */
export const SCHEMA_VERSION = 3

/**
 * 建表语句，按顺序执行（整体包在一个事务里）。
 *
 * - `settings`：通用键值配置表。值统一按 **JSON 字符串**存放，解析与校验交给调用方
 *   （见 lib/config-store.ts），这样新增配置项不需要改表结构。
 * - `device`：设备指纹 + 匿名票据，**单行表**（`id` 恒为 1，用 CHECK 约束兜底）。
 *   免登模式必须持久化 buvid3 / buvid4 / b_nut，否则每次启动都相当于"换了一台设备"，
 *   极易触发风控；`bili_ticket` 是**设备级匿名票据**（不是账号凭据），生命周期与指纹一致，
 *   因此同表存放。指纹三列允许 NULL，是为了支持"先拿到票据、后拿到指纹"的写入顺序。
 * - `wbi_keys`：WBI 签名所需的 img_key / sub_key，同样是单行表；key 按自然日轮换，
 *   新的直接覆盖旧的（不保留历史，历史 key 已失效且无诊断价值）。
 */
export const SCHEMA_SQL: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS settings (
     key        TEXT PRIMARY KEY,
     value      TEXT NOT NULL,
     updated_at INTEGER NOT NULL
   )`,

  `CREATE TABLE IF NOT EXISTS device (
     id               INTEGER PRIMARY KEY CHECK (id = 1),
     buvid3           TEXT,
     buvid4           TEXT,
     b_nut            INTEGER,
     bili_ticket      TEXT,
     ticket_expire_at INTEGER,
     updated_at       INTEGER NOT NULL
   )`,

  `CREATE TABLE IF NOT EXISTS wbi_keys (
     id         INTEGER PRIMARY KEY CHECK (id = 1),
     img_key    TEXT NOT NULL,
     sub_key    TEXT NOT NULL,
     fetched_at INTEGER NOT NULL
   )`,

  `CREATE TABLE IF NOT EXISTS tasks (
     id         TEXT PRIMARY KEY,
     snapshot   TEXT NOT NULL,
     status     TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_tasks_updated_at ON tasks(updated_at DESC)`,
  `CREATE TABLE IF NOT EXISTS accounts (
     id                 TEXT PRIMARY KEY,
     platform           TEXT NOT NULL,
     label              TEXT NOT NULL,
     display_name       TEXT NOT NULL DEFAULT '',
     status             TEXT NOT NULL,
     logged_in          INTEGER NOT NULL DEFAULT 0,
     vip                INTEGER NOT NULL DEFAULT 0,
     active             INTEGER NOT NULL DEFAULT 0,
     last_verified_at   INTEGER,
     updated_at         INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_accounts_platform_active ON accounts(platform, active)`,
]
