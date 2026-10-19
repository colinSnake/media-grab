import type { Database } from './db.js'
import { accountPlatformSchema, accountStatusSchema, taskSnapshotSchema, type AccountPlatform, type AccountStatus, type TaskSnapshot } from '@mediagrab/shared'

/**
 * 行数据读取辅助。
 * node:sqlite 返回的列值类型是 `null | number | bigint | string | Uint8Array`，
 * 直接用会污染上层类型；这里统一按列的真实语义收窄，
 * 类型不符（含 NULL）时返回 null，由各自的仓储决定"算缺失"还是"算损坏"。
 */
function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' ? value : null
}

function asBoolean(value: unknown): boolean {
  return value === 1 || value === true
}

export interface DeviceRecord {
  buvid3: string
  buvid4: string
  bNut: number
  biliTicket: string | null
  ticketExpireAt: number | null
  updatedAt: number
}

/** device 表的原始行（指纹三列在库里可为 NULL，见 store/schema.ts 的设计说明） */
interface DeviceRow {
  buvid3: string | null
  buvid4: string | null
  bNut: number | null
  biliTicket: string | null
  ticketExpireAt: number | null
  updatedAt: number
}

const DEVICE_SELECT = `SELECT buvid3, buvid4, b_nut, bili_ticket, ticket_expire_at, updated_at
   FROM device WHERE id = 1`

/**
 * 设备指纹仓储（单行表）。
 *
 * 免登优先：账号凭据一概不存，但**设备身份**必须持久化，
 * 否则每次启动都像新设备，接口会更快被风控拦截。
 */
export class DeviceRepository {
  #db: Database

  constructor(db: Database) {
    this.#db = db
  }

  get(): DeviceRecord | null {
    const row = this.#read()
    if (row === null) return null
    // 指纹三要素缺任意一项都视为"尚无可用指纹"：不完整的指纹拿去请求反而更容易被识别为异常设备
    if (row.buvid3 === null || row.buvid4 === null || row.bNut === null) return null
    return {
      buvid3: row.buvid3,
      buvid4: row.buvid4,
      bNut: row.bNut,
      biliTicket: row.biliTicket,
      ticketExpireAt: row.ticketExpireAt,
      updatedAt: row.updatedAt,
    }
  }

  /** 首次写入或整体覆盖指纹字段；保留已存在的 ticket 字段 */
  save(input: { buvid3: string; buvid4: string; bNut: number; updatedAt?: number }): DeviceRecord {
    const updatedAt = input.updatedAt ?? Date.now()

    // upsert 里**不出现** ticket 列：冲突时只覆盖指纹列，已有的票据天然被保留
    this.#db
      .prepare(
        `INSERT INTO device (id, buvid3, buvid4, b_nut, updated_at)
         VALUES (1, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           buvid3     = excluded.buvid3,
           buvid4     = excluded.buvid4,
           b_nut      = excluded.b_nut,
           updated_at = excluded.updated_at`,
      )
      .run(input.buvid3, input.buvid4, input.bNut, updatedAt)

    const record = this.get()
    if (record === null) {
      // 刚写完就读不回来只可能是底层状态异常，不做静默兜底
      throw new Error('device 记录写入后未能读回，数据库状态异常')
    }
    return record
  }

  /** 写入/刷新匿名票据（设备级，非账号凭据） */
  saveTicket(ticket: string, expireAt: number): void {
    this.#db
      .prepare(
        `INSERT INTO device (id, bili_ticket, ticket_expire_at, updated_at)
         VALUES (1, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           bili_ticket      = excluded.bili_ticket,
           ticket_expire_at = excluded.ticket_expire_at,
           updated_at       = excluded.updated_at`,
      )
      .run(ticket, expireAt, Date.now())
  }

  /**
   * 只读票据。
   *
   * 刻意**不**复用 `get()`：`get()` 在指纹三列不全时返回 null（那对"取指纹"是对的），
   * 但票据与指纹的写入顺序不应成为约束 —— 否则"票据已存但指纹列还空"会被误判成没票据，
   * 每次请求都重新申请一张（票据接口本身也吃风控额度）。
   */
  getTicket(): { ticket: string; expireAt: number } | null {
    const row = this.#db
      .prepare('SELECT bili_ticket, ticket_expire_at FROM device WHERE id = 1')
      .get()
    if (row === undefined) return null
    const ticket = asString(row['bili_ticket'])
    const expireAt = asNumber(row['ticket_expire_at'])
    if (ticket === null || expireAt === null) return null
    return { ticket, expireAt }
  }

  /** 票据失效或明确不可用时清空；指纹保持不变 */
  clearTicket(): void {
    this.#db
      .prepare(
        `UPDATE device
            SET bili_ticket = NULL, ticket_expire_at = NULL, updated_at = ?
          WHERE id = 1`,
      )
      .run(Date.now())
  }

  #read(): DeviceRow | null {
    const row = this.#db.prepare(DEVICE_SELECT).get()
    if (row === undefined) return null
    return {
      buvid3: asString(row['buvid3']),
      buvid4: asString(row['buvid4']),
      bNut: asNumber(row['b_nut']),
      biliTicket: asString(row['bili_ticket']),
      ticketExpireAt: asNumber(row['ticket_expire_at']),
      updatedAt: asNumber(row['updated_at']) ?? 0,
    }
  }
}

export interface WbiKeyRecord {
  imgKey: string
  subKey: string
  fetchedAt: number
}

/**
 * WBI 签名 key 仓储（单行表）。
 *
 * img_key/sub_key 每天轮换，取新的直接覆盖旧的：历史 key 已失效，留着只会误导排查。
 */
export class WbiKeyRepository {
  #db: Database

  constructor(db: Database) {
    this.#db = db
  }

  get(): WbiKeyRecord | null {
    const row = this.#db
      .prepare('SELECT img_key, sub_key, fetched_at FROM wbi_keys WHERE id = 1')
      .get()
    if (row === undefined) return null
    const imgKey = asString(row['img_key'])
    const subKey = asString(row['sub_key'])
    if (imgKey === null || subKey === null) return null
    return { imgKey, subKey, fetchedAt: asNumber(row['fetched_at']) ?? 0 }
  }

  save(input: { imgKey: string; subKey: string; fetchedAt: number }): void {
    // 固定 id=1 + upsert：无论调用多少次都只有一行（CHECK 约束兜底）
    this.#db
      .prepare(
        `INSERT INTO wbi_keys (id, img_key, sub_key, fetched_at)
         VALUES (1, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           img_key    = excluded.img_key,
           sub_key    = excluded.sub_key,
           fetched_at = excluded.fetched_at`,
      )
      .run(input.imgKey, input.subKey, input.fetchedAt)
  }

  /** 清空缓存，下次使用前会重新拉取 */
  clear(): void {
    this.#db.prepare('DELETE FROM wbi_keys').run()
  }
}

/**
 * 配置键值仓储。
 *
 * value 一律按 JSON 字符串原样存取（本层**不做**解析与校验），
 * 语义解释集中在 lib/config-store.ts —— 表结构因此与配置项解耦。
 */
export class SettingsRepository {
  #db: Database

  constructor(db: Database) {
    this.#db = db
  }

  /** 全部键值（值按 JSON 字符串存放与返回，解析交给调用方） */
  all(): Record<string, string> {
    const rows = this.#db.prepare('SELECT key, value FROM settings ORDER BY key').all()
    const result: Record<string, string> = {}
    for (const row of rows) {
      const key = asString(row['key'])
      const value = asString(row['value'])
      // 表约束保证两者非空；类型收窄只是为了满足 noUncheckedIndexedAccess
      if (key !== null && value !== null) result[key] = value
    }
    return result
  }

  get(key: string): string | null {
    const row = this.#db.prepare('SELECT value FROM settings WHERE key = ?').get(key)
    if (row === undefined) return null
    return asString(row['value'])
  }

  set(key: string, value: string, updatedAt: number = Date.now()): void {
    this.#setOne(key, value, updatedAt)
  }

  setMany(values: Record<string, string>, updatedAt: number = Date.now()): void {
    const keys = Object.keys(values)
    if (keys.length === 0) return

    // 一个 patch 请求可能改多项：要么全成功要么全失败，避免配置落到一半
    this.#db.transaction(() => {
      for (const key of keys) {
        const value = values[key]
        if (value === undefined) continue
        this.#setOne(key, value, updatedAt)
      }
    })
  }

  delete(key: string): void {
    this.#db.prepare('DELETE FROM settings WHERE key = ?').run(key)
  }

  #setOne(key: string, value: string, updatedAt: number): void {
    this.#db
      .prepare(
        `INSERT INTO settings (key, value, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET
           value      = excluded.value,
           updated_at = excluded.updated_at`,
      )
      .run(key, value, updatedAt)
  }
}

/** 持久化下载任务快照；任务的业务状态由 TaskService 推进，仓储只负责可靠读写。 */
export class TaskRepository {
  #db: Database

  constructor(db: Database) {
    this.#db = db
  }

  list(): TaskSnapshot[] {
    const rows = this.#db
      .prepare('SELECT snapshot FROM tasks ORDER BY updated_at DESC')
      .all()
    const result: TaskSnapshot[] = []
    for (const row of rows) {
      const raw = asString(row['snapshot'])
      if (raw === null) continue
      try {
        const parsed = taskSnapshotSchema.safeParse(JSON.parse(raw))
        if (parsed.success) result.push(parsed.data)
      } catch {
        // 损坏的历史任务不应阻塞应用启动；诊断信息留给数据库检查工具。
      }
    }
    return result
  }

  get(id: string): TaskSnapshot | null {
    const row = this.#db.prepare('SELECT snapshot FROM tasks WHERE id = ?').get(id)
    if (row === undefined) return null
    const raw = asString(row['snapshot'])
    if (raw === null) return null
    try {
      const parsed = taskSnapshotSchema.safeParse(JSON.parse(raw))
      return parsed.success ? parsed.data : null
    } catch {
      return null
    }
  }

  save(task: TaskSnapshot): void {
    const now = task.updatedAt
    this.#db
      .prepare(
        `INSERT INTO tasks (id, snapshot, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           snapshot = excluded.snapshot,
           status = excluded.status,
           updated_at = excluded.updated_at`,
      )
      .run(task.id, JSON.stringify(task), task.status, now, now)
  }

  delete(id: string): void {
    this.#db.prepare('DELETE FROM tasks WHERE id = ?').run(id)
  }
}

export interface AccountRecord {
  id: string
  platform: AccountPlatform
  label: string
  displayName: string
  status: AccountStatus
  loggedIn: boolean
  vip: boolean
  active: boolean
  lastVerifiedAt: number | null
  updatedAt: number
}

/** 账号元数据仓储；凭据本身由 CredentialVault 独立保存。 */
export class AccountRepository {
  #db: Database

  constructor(db: Database) {
    this.#db = db
  }

  list(platform?: AccountPlatform): AccountRecord[] {
    const rows = platform === undefined
      ? this.#db.prepare('SELECT * FROM accounts ORDER BY active DESC, updated_at DESC').all()
      : this.#db.prepare('SELECT * FROM accounts WHERE platform = ? ORDER BY active DESC, updated_at DESC').all(platform)
    return rows.flatMap((row) => {
      const parsedPlatform = accountPlatformSchema.safeParse(row['platform'])
      const parsedStatus = accountStatusSchema.safeParse(row['status'])
      if (!parsedPlatform.success || !parsedStatus.success) return []
      return [{
        id: String(row['id']),
        platform: parsedPlatform.data,
        label: String(row['label'] ?? ''),
        displayName: String(row['display_name'] ?? ''),
        status: parsedStatus.data,
        loggedIn: asBoolean(row['logged_in']),
        vip: asBoolean(row['vip']),
        active: asBoolean(row['active']),
        lastVerifiedAt: asNumber(row['last_verified_at']),
        updatedAt: asNumber(row['updated_at']) ?? 0,
      }]
    })
  }

  get(id: string): AccountRecord | null {
    return this.list().find((item) => item.id === id) ?? null
  }

  save(account: AccountRecord): void {
    this.#db.prepare(`
      INSERT INTO accounts (id, platform, label, display_name, status, logged_in, vip, active, last_verified_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        platform = excluded.platform,
        label = excluded.label,
        display_name = excluded.display_name,
        status = excluded.status,
        logged_in = excluded.logged_in,
        vip = excluded.vip,
        active = excluded.active,
        last_verified_at = excluded.last_verified_at,
        updated_at = excluded.updated_at
    `).run(
      account.id, account.platform, account.label, account.displayName, account.status,
      account.loggedIn ? 1 : 0, account.vip ? 1 : 0, account.active ? 1 : 0,
      account.lastVerifiedAt, account.updatedAt,
    )
  }

  setActive(platform: AccountPlatform, id: string): void {
    this.#db.transaction(() => {
      this.#db.prepare('UPDATE accounts SET active = 0, updated_at = ? WHERE platform = ?').run(Date.now(), platform)
      this.#db.prepare('UPDATE accounts SET active = 1, updated_at = ? WHERE id = ? AND platform = ?').run(Date.now(), id, platform)
    })
  }

  delete(id: string): void {
    this.#db.prepare('DELETE FROM accounts WHERE id = ?').run(id)
  }
}
