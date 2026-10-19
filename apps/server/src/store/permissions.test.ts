import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { Database } from './db.js'

/**
 * 本地库的权限底线（TECH-DESIGN §9）。
 *
 * M1 的库里只有设备指纹与匿名票据；M4 登录后同一张库会存加密凭据，
 * 因此现在就把"目录 0700 + 文件 0600"锁定，避免迁移时才发现权限没收紧。
 */
describe('SQLite 文件权限', () => {
  it('目录 0700、库文件 0600，且 -wal/-shm 继承同样的权限', () => {
    const parent = mkdtempSync(path.join(tmpdir(), 'mediaGrab-perm-'))
    const dir = path.join(parent, 'data')
    const file = path.join(dir, 'x.db')
    const db = Database.open(file)
    try {
      // 触发 WAL/SHM 文件落盘
      db.exec('CREATE TABLE IF NOT EXISTS t (a INTEGER)')
      db.prepare('INSERT INTO t (a) VALUES (?)').run(1)

      const mode = (target: string): string => (statSync(target).mode & 0o777).toString(8)
      expect(mode(dir)).toBe('700')
      expect(mode(file)).toBe('600')
      expect(mode(`${file}-wal`)).toBe('600')
      expect(mode(`${file}-shm`)).toBe('600')
    } finally {
      db.close()
      rmSync(parent, { recursive: true, force: true })
    }
  })

  it('内存库不受影响', () => {
    const db = Database.open(':memory:')
    expect(db.file).toBe(':memory:')
    db.close()
  })
})
