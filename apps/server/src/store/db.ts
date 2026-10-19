import { chmodSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import type { StatementSync } from 'node:sqlite'
import { SCHEMA_SQL, SCHEMA_VERSION } from './schema.js'

/**
 * 运行时取用内置的 node:sqlite。
 *
 * 之所以不用静态 `import { DatabaseSync } from 'node:sqlite'`：
 * vitest 2.x 依赖的 vite-node 用「`module.builtinModules` + 少量硬编码」判断内置模块，
 * 而 Node 的 builtinModules **不包含**只能带 `node:` 前缀引入的模块（test/sqlite/sea），
 * 于是静态 import 会被当成裸包名 `sqlite` 去解析并报 "Failed to load url sqlite"。
 * process.getBuiltinModule 是 Node 22.3+ 的官方运行时入口，语义与静态 import 完全一致，
 * 且不需要任何 vitest 配置；类型仍由 `import type` 提供。
 */
const sqliteModule = process.getBuiltinModule('node:sqlite') as
  | typeof import('node:sqlite')
  | undefined

if (sqliteModule === undefined) {
  throw new Error(
    '当前 Node 运行时没有内置模块 node:sqlite（需要 Node >= 22.5，推荐 24.x LTS）。',
  )
}

const { DatabaseSync } = sqliteModule

/** 内存库路径；内存库不支持 WAL，也不该去建目录 */
const MEMORY = ':memory:'

/** 连接实例类型（DatabaseSync 由运行时取得，故用 InstanceType 反推） */
type DatabaseSyncInstance = InstanceType<typeof DatabaseSync>

/**
 * SQLite 连接封装（零原生依赖：node:sqlite 随 Node 内置）。
 *
 * 全同步 API —— 上层（配置、设备指纹、WBI key）都保持同步调用，
 * 不引入 Promise 包装，避免"异步句柄被误当同步用"的隐性 bug。
 *
 * 职责：
 * 1. 打开即配置连接（WAL / 外键 / busy_timeout）；
 * 2. 用 `PRAGMA user_version` 做迁移，并**拒绝**打开比本程序更新的库；
 * 3. 提供事务包装与幂等的 close()。
 */
export class Database {
  /** 实际打开的数据库路径（':memory:' 原样保留，文件路径为绝对路径） */
  readonly file: string

  #db: DatabaseSyncInstance
  #closed: boolean

  private constructor(file: string, db: DatabaseSyncInstance) {
    this.file = file
    this.#db = db
    this.#closed = false
  }

  /** 打开数据库；':memory:' 用于测试；文件路径会自动创建父目录（mode 0o700） */
  static open(file: string): Database {
    const target = file === MEMORY ? MEMORY : path.resolve(file)
    if (target !== MEMORY) {
      // 首次启动时数据目录可能还不存在：递归创建并收紧权限，
      // 因为库里会存设备指纹等本地私有数据（见 docs/TECH-DESIGN.md 的安全约束）。
      mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 })
    }

    const raw = new DatabaseSync(target)
    // 库文件收紧到 0600：M4 登录后这里会存加密凭据，提前把权限对齐（目录 0700 之外再加一层）。
    // 必须在开启 WAL **之前** chmod —— SQLite 会用与库文件相同的权限创建 -wal/-shm。
    if (target !== MEMORY) {
      try {
        chmodSync(target, 0o600)
      } catch {
        // 某些文件系统（如挂载的 FAT/网络盘）不支持 chmod；目录 0700 仍是有效防线，不因此启动失败
      }
    }
    const db = new Database(target, raw)
    try {
      db.#configure()
    } catch (err) {
      // 迁移/配置失败时不能泄漏底层连接，否则文件会被一直占着（Windows 上尤其明显）
      try {
        raw.close()
      } catch {
        // 关闭失败无能为力，真正要报的是上面那个错误
      }
      throw err
    }
    return db
  }

  exec(sql: string): void {
    this.#assertOpen()
    this.#db.exec(sql)
  }

  prepare(sql: string): StatementSync {
    this.#assertOpen()
    return this.#db.prepare(sql)
  }

  /** 事务包一层（BEGIN IMMEDIATE / COMMIT / 失败 ROLLBACK） */
  transaction<T>(fn: () => T): T {
    this.#assertOpen()

    // BEGIN IMMEDIATE 立刻拿写锁，避免升级锁时才发现冲突（SQLITE_BUSY 更可控）。
    // 嵌套调用不重复开启事务：内层直接执行，提交/回滚由最外层决定。
    if (this.#inTransaction()) return fn()

    this.#db.exec('BEGIN IMMEDIATE')
    try {
      const result = fn()
      this.#db.exec('COMMIT')
      return result
    } catch (err) {
      try {
        this.#db.exec('ROLLBACK')
      } catch {
        // 回滚本身失败（例如连接已断）时保留原始异常，它才是有诊断价值的那个
      }
      throw err
    }
  }

  close(): void {
    // 幂等：调用方（含测试的 cleanup 与业务里的兜底关闭）可能重复调用
    if (this.#closed) return
    this.#closed = true
    if (this.#db.isOpen) this.#db.close()
  }

  /** 连接级 PRAGMA + 迁移 */
  #configure(): void {
    // WAL 让读写不互相阻塞；内存库不支持该模式，测试路径直接跳过
    if (this.file !== MEMORY) this.#db.exec('PRAGMA journal_mode = WAL')
    this.#db.exec('PRAGMA foreign_keys = ON')
    this.#db.exec('PRAGMA busy_timeout = 5000')
    this.#migrate()
  }

  #migrate(): void {
    const version = this.#userVersion()

    // 库比程序新：继续用旧程序写会破坏结构，必须显式失败而不是"尽量兼容"
    if (version > SCHEMA_VERSION) {
      throw new Error(
        `数据库 ${this.file} 的 schema 版本为 ${version}，高于本程序支持的 ${SCHEMA_VERSION}。` +
          '请升级 mediaGrab 后再打开，避免旧版本写入破坏新库。',
      )
    }

    // 已是当前版本：什么都不做（迁移只跑一次）
    if (version === SCHEMA_VERSION) return

    // 建表语句均为 IF NOT EXISTS，因此从任意旧版本升级都可安全重跑
    this.transaction(() => {
      for (const sql of SCHEMA_SQL) this.#db.exec(sql)
      // PRAGMA 不接受占位符；SCHEMA_VERSION 是编译期常量，拼接安全
      this.#db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`)
    })
  }

  #userVersion(): number {
    const row = this.#db.prepare('PRAGMA user_version').get()
    const value = row?.['user_version']
    // 任何非数字结果（理论上不会出现）都按 0 处理，让迁移重跑一遍
    return typeof value === 'number' ? value : 0
  }

  #inTransaction(): boolean {
    // node:sqlite 未提供该属性时（旧版本运行时）退化为"永远开启新事务"
    return this.#db.isTransaction === true
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error(`数据库 ${this.file} 已关闭`)
  }
}
