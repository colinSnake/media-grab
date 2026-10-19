import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Database } from './db.js'
import {
  DeviceRepository,
  SettingsRepository,
  TaskRepository,
  WbiKeyRepository,
} from './repositories.js'
import type { TaskSnapshot } from '@mediagrab/shared'
import { SCHEMA_VERSION } from './schema.js'

/**
 * 仓储层测试。
 *
 * 两种打开方式都要覆盖：
 * - ':memory:'：快、隔离好，覆盖 SQL 语义；
 * - 临时文件：覆盖迁移、持久化与重新打开的真实路径。
 * 临时目录一律在 afterEach 里清掉，避免污染本机。
 */

const cleanups: Array<() => void> = []

afterEach(() => {
  // 逆序清理：先关连接（Database.close 是幂等的），再删临时目录
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
})

function openMemory(): Database {
  const db = Database.open(':memory:')
  cleanups.push(() => db.close())
  return db
}

function openTempFile(): { db: Database; file: string; dir: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'mediaGrab-store-'))
  const file = path.join(dir, 'app.db')
  const db = Database.open(file)
  cleanups.push(() => {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })
  return { db, file, dir }
}

function userVersion(db: Database): unknown {
  return db.prepare('PRAGMA user_version').get()?.['user_version']
}

describe('Database', () => {
  it('内存库能建表并把 user_version 设为 SCHEMA_VERSION', () => {
    const db = openMemory()
    expect(userVersion(db)).toBe(SCHEMA_VERSION)

    // 三张表都可用（否则这里会抛 no such table）
    expect(db.prepare('SELECT count(*) AS n FROM settings').get()?.['n']).toBe(0)
    expect(db.prepare('SELECT count(*) AS n FROM device').get()?.['n']).toBe(0)
    expect(db.prepare('SELECT count(*) AS n FROM wbi_keys').get()?.['n']).toBe(0)
  })

  it('文件库：重复打开不会重跑迁移，也不会清掉已有数据', () => {
    const { db, file } = openTempFile()
    new SettingsRepository(db).set('savePath', JSON.stringify('/tmp/keep'))
    db.close()

    const again = Database.open(file)
    cleanups.push(() => again.close())
    expect(userVersion(again)).toBe(SCHEMA_VERSION)
    expect(new SettingsRepository(again).get('savePath')).toBe(JSON.stringify('/tmp/keep'))
  })

  it('user_version 高于 SCHEMA_VERSION 时拒绝打开', () => {
    const { db, file } = openTempFile()
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`)
    db.close()

    expect(() => Database.open(file)).toThrowError(/高于本程序支持/)
  })

  it('close() 幂等；关闭后操作会报错', () => {
    const db = Database.open(':memory:')
    db.close()
    expect(() => db.close()).not.toThrow()
    expect(() => db.exec('SELECT 1')).toThrowError(/已关闭/)
    expect(() => db.prepare('SELECT 1')).toThrowError(/已关闭/)
  })

  it('transaction 提交成功结果，异常时回滚', () => {
    const db = openMemory()
    const repo = new SettingsRepository(db)

    const returned = db.transaction(() => {
      repo.set('a', '1')
      return 'ok'
    })
    expect(returned).toBe('ok')
    expect(repo.get('a')).toBe('1')

    expect(() =>
      db.transaction(() => {
        repo.set('b', '2')
        throw new Error('boom')
      }),
    ).toThrowError('boom')
    expect(repo.get('b')).toBeNull()
  })
})

describe('DeviceRepository', () => {
  it('save 后 get 一致（含默认 updatedAt）', () => {
    const repo = new DeviceRepository(openMemory())
    expect(repo.get()).toBeNull()

    const before = Date.now()
    const saved = repo.save({ buvid3: 'BV3', buvid4: 'BV4', bNut: 1234 })

    expect(saved).toEqual({
      buvid3: 'BV3',
      buvid4: 'BV4',
      bNut: 1234,
      biliTicket: null,
      ticketExpireAt: null,
      updatedAt: saved.updatedAt,
    })
    expect(saved.updatedAt).toBeGreaterThanOrEqual(before)
    expect(repo.get()).toEqual(saved)
  })

  it('save 用传入的 updatedAt；第二次 save 覆盖指纹但保留已保存的 ticket', () => {
    const repo = new DeviceRepository(openMemory())
    repo.save({ buvid3: 'BV3', buvid4: 'BV4', bNut: 1, updatedAt: 100 })
    repo.saveTicket('ticket-1', 9999)

    const overwritten = repo.save({ buvid3: 'BV3-new', buvid4: 'BV4-new', bNut: 2, updatedAt: 200 })
    expect(overwritten).toEqual({
      buvid3: 'BV3-new',
      buvid4: 'BV4-new',
      bNut: 2,
      biliTicket: 'ticket-1',
      ticketExpireAt: 9999,
      updatedAt: 200,
    })
    expect(repo.get()).toEqual(overwritten)
  })

  it('saveTicket / clearTicket 只影响票据字段', () => {
    const repo = new DeviceRepository(openMemory())
    repo.save({ buvid3: 'BV3', buvid4: 'BV4', bNut: 1, updatedAt: 100 })

    repo.saveTicket('ticket-2', 8888)
    expect(repo.get()).toMatchObject({ biliTicket: 'ticket-2', ticketExpireAt: 8888 })

    repo.saveTicket('ticket-3', 9999)
    expect(repo.get()).toMatchObject({ biliTicket: 'ticket-3', ticketExpireAt: 9999 })

    repo.clearTicket()
    const cleared = repo.get()
    expect(cleared).toMatchObject({
      buvid3: 'BV3',
      buvid4: 'BV4',
      bNut: 1,
      biliTicket: null,
      ticketExpireAt: null,
    })
  })

  it('没有指纹时先写票据也不会造出"半截指纹"', () => {
    const repo = new DeviceRepository(openMemory())
    repo.saveTicket('early-ticket', 111)
    // 表里已有行，但指纹三列还是 NULL → get() 视为尚无指纹
    expect(repo.get()).toBeNull()

    const saved = repo.save({ buvid3: 'BV3', buvid4: 'BV4', bNut: 7, updatedAt: 300 })
    expect(saved.biliTicket).toBe('early-ticket')
  })

  it('文件库重新打开后设备指纹仍在', () => {
    const { db, file } = openTempFile()
    new DeviceRepository(db).save({ buvid3: 'BV3', buvid4: 'BV4', bNut: 42, updatedAt: 500 })
    db.close()

    const again = Database.open(file)
    cleanups.push(() => again.close())
    expect(new DeviceRepository(again).get()).toEqual({
      buvid3: 'BV3',
      buvid4: 'BV4',
      bNut: 42,
      biliTicket: null,
      ticketExpireAt: null,
      updatedAt: 500,
    })
  })
})

describe('WbiKeyRepository', () => {
  it('get / save / clear', () => {
    const repo = new WbiKeyRepository(openMemory())
    expect(repo.get()).toBeNull()

    repo.save({ imgKey: 'img-a', subKey: 'sub-a', fetchedAt: 1 })
    expect(repo.get()).toEqual({ imgKey: 'img-a', subKey: 'sub-a', fetchedAt: 1 })

    repo.clear()
    expect(repo.get()).toBeNull()
  })

  it('重复 save 只覆盖同一行', () => {
    const db = openMemory()
    const repo = new WbiKeyRepository(db)

    repo.save({ imgKey: 'img-a', subKey: 'sub-a', fetchedAt: 1 })
    repo.save({ imgKey: 'img-b', subKey: 'sub-b', fetchedAt: 2 })

    expect(repo.get()).toEqual({ imgKey: 'img-b', subKey: 'sub-b', fetchedAt: 2 })
    expect(db.prepare('SELECT count(*) AS n FROM wbi_keys').get()?.['n']).toBe(1)
  })
})

describe('SettingsRepository', () => {
  it('set / get / delete，重复 set 覆盖旧值', () => {
    const repo = new SettingsRepository(openMemory())
    expect(repo.get('missing')).toBeNull()

    repo.set('savePath', JSON.stringify('/tmp/a'), 1000)
    expect(repo.get('savePath')).toBe(JSON.stringify('/tmp/a'))

    repo.set('savePath', JSON.stringify('/tmp/b'), 2000)
    expect(repo.get('savePath')).toBe(JSON.stringify('/tmp/b'))

    repo.delete('savePath')
    expect(repo.get('savePath')).toBeNull()
  })

  it('setMany 一次写多键，all 按 key 排序返回', () => {
    const repo = new SettingsRepository(openMemory())
    repo.setMany({ downloadPoolSize: '5', audioContainer: '"mp3"', bindHost: '"127.0.0.1"' }, 3000)

    expect(repo.all()).toEqual({
      audioContainer: '"mp3"',
      bindHost: '"127.0.0.1"',
      downloadPoolSize: '5',
    })
    expect(Object.keys(repo.all())).toEqual(['audioContainer', 'bindHost', 'downloadPoolSize'])
  })

  it('JSON 字符串原样存取（本层不解析）', () => {
    const repo = new SettingsRepository(openMemory())
    const raw = JSON.stringify({ nested: [1, 'two', null] })
    repo.set('weird', raw)
    expect(repo.get('weird')).toBe(raw)

    // 非法 JSON 也照存不误：校验是 ConfigStore 的职责
    repo.set('broken', '{not json')
    expect(repo.get('broken')).toBe('{not json')
  })

  it('setMany 空对象不报错', () => {
    const repo = new SettingsRepository(openMemory())
    expect(() => repo.setMany({})).not.toThrow()
    expect(repo.all()).toEqual({})
  })

  it('文件库重新打开后配置仍在', () => {
    const { db, file } = openTempFile()
    new SettingsRepository(db).set('savePath', JSON.stringify('/tmp/persist'), 4000)
    db.close()

    const again = Database.open(file)
    cleanups.push(() => again.close())
    expect(new SettingsRepository(again).get('savePath')).toBe(JSON.stringify('/tmp/persist'))
  })
})

describe('TaskRepository', () => {
  it('保存、读取、按更新时间排序并删除任务快照', () => {
    const repo = new TaskRepository(openMemory())
    const first: TaskSnapshot = {
      id: 'task-a', platform: 'bilibili', input: 'BV1GJ411x7h7', sourceId: 'BV1GJ411x7h7', bvid: 'BV1GJ411x7h7', cid: 1,
      title: 'A', status: 'waiting', phase: 'pending', mode: 'video+audio', qn: 32,
      totalBytes: 0, downloadedBytes: 0, speedBps: 0, fileName: '', error: '', updatedAt: 10,
    }
    const second = { ...first, id: 'task-b', title: 'B', updatedAt: 20 }

    repo.save(first)
    repo.save(second)
    expect(repo.get('task-a')).toEqual(first)
    expect(repo.list().map((task) => task.id)).toEqual(['task-b', 'task-a'])

    repo.delete('task-a')
    expect(repo.get('task-a')).toBeNull()
  })

  it('损坏的快照不会阻塞任务列表', () => {
    const db = openMemory()
    db.prepare('INSERT INTO tasks (id, snapshot, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run('broken', '{bad json', 'fail', 1, 1)
    expect(new TaskRepository(db).list()).toEqual([])
  })
})
