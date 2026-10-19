import { afterEach, describe, expect, it } from 'vitest'
import { ZodError } from 'zod'
import { defaultAppConfig } from '@mediagrab/shared'
import { Database } from '../store/db.js'
import { SettingsRepository } from '../store/repositories.js'
import { ConfigStore } from './config-store.js'
import { ApiError } from './errors.js'

/**
 * ConfigStore 测试：内存库即可（落库语义由 store/repositories.test.ts 覆盖），
 * 这里关心的是"逐字段 JSON 存取 + 校验回退 + 缓存/库一致性"。
 */

const cleanups: Array<() => void> = []

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
})

function setup(): { db: Database; repo: SettingsRepository } {
  const db = Database.open(':memory:')
  cleanups.push(() => db.close())
  return { db, repo: new SettingsRepository(db) }
}

/** 取出抛出的异常，便于断言 code / 类型 */
function capture(fn: () => unknown): unknown {
  try {
    fn()
  } catch (err) {
    return err
  }
  throw new Error('期望抛出异常，但调用正常返回了')
}

describe('ConfigStore.load', () => {
  it('空库 → 等于 defaultAppConfig()，且没有任何已落库的键', () => {
    const { repo } = setup()
    const store = ConfigStore.load(repo, defaultAppConfig())

    expect(store.get()).toEqual(defaultAppConfig())
    expect(store.persistedKeys()).toEqual([])
  })

  it('库里存了非法 JSON 时回落默认值，不抛错', () => {
    const { repo } = setup()
    repo.set('downloadPoolSize', '{oops')
    repo.set('savePath', 'not-json-at-all')

    const store = ConfigStore.load(repo, defaultAppConfig())

    expect(store.get()).toEqual(defaultAppConfig())
    // 键确实在库里（只是值坏了），诊断信息如实反映
    expect(store.persistedKeys()).toEqual(['downloadPoolSize', 'savePath'])
  })

  it('合法 JSON 但取值越界/不符合枚举时，只回退该字段', () => {
    const { repo } = setup()
    repo.set('downloadPoolSize', JSON.stringify(999)) // 超出 max 16
    repo.set('defaultDownloadMode', JSON.stringify('nope')) // 不在枚举里
    repo.set('savePath', JSON.stringify('/tmp/ok')) // 合法

    const store = ConfigStore.load(repo, defaultAppConfig())

    expect(store.get().savePath).toBe('/tmp/ok')
    expect(store.get().downloadPoolSize).toBe(defaultAppConfig().downloadPoolSize)
    expect(store.get().defaultDownloadMode).toBe(defaultAppConfig().defaultDownloadMode)
  })

  it('库里的未知（历史遗留）键既不影响配置，也不计入 persistedKeys', () => {
    const { repo } = setup()
    repo.set('legacyRemovedField', JSON.stringify(1))
    repo.set('savePath', JSON.stringify('/tmp/kept'))

    const store = ConfigStore.load(repo, defaultAppConfig())

    expect(store.get().savePath).toBe('/tmp/kept')
    expect(store.persistedKeys()).toEqual(['savePath'])
  })

  it('数组字段能正确还原', () => {
    const { repo } = setup()
    repo.set('videoCodecPriority', JSON.stringify(['av1']))
    repo.set('audioQualityPriority', JSON.stringify([30216, 30280]))

    const store = ConfigStore.load(repo, defaultAppConfig())

    expect(store.get().videoCodecPriority).toEqual(['av1'])
    expect(store.get().audioQualityPriority).toEqual([30216, 30280])
  })
})

describe('ConfigStore.patch', () => {
  it('局部更新生效并写库；重新 load 能读回', () => {
    const { repo } = setup()
    const defaults = defaultAppConfig()
    const store = ConfigStore.load(repo, defaults)

    const patched = store.patch({ savePath: '/tmp/x', downloadPoolSize: 5 })

    expect(patched.savePath).toBe('/tmp/x')
    expect(patched.downloadPoolSize).toBe(5)
    // 未改动的字段保持原值
    expect(patched.audioContainer).toBe(defaults.audioContainer)

    // 真的落库了：值按 JSON 字符串存放
    expect(repo.get('savePath')).toBe(JSON.stringify('/tmp/x'))
    expect(repo.get('downloadPoolSize')).toBe('5')

    // 同一个 Database 重新 load：配置持久化可读回
    const reloaded = ConfigStore.load(repo, defaults)
    expect(reloaded.get()).toEqual(patched)
    expect(reloaded.persistedKeys()).toEqual(['downloadPoolSize', 'savePath'])
  })

  it('只写真正变化的键', () => {
    const { repo } = setup()
    const defaults = defaultAppConfig()
    const store = ConfigStore.load(repo, defaults)

    store.patch({ savePath: '/tmp/x' })
    expect(store.persistedKeys()).toEqual(['savePath'])

    // 同一个值再 patch 一次：不产生新的落库键，也不改变配置
    const again = store.patch({ savePath: '/tmp/x' })
    expect(again.savePath).toBe('/tmp/x')
    expect(store.persistedKeys()).toEqual(['savePath'])

    // 空 patch 没有任何副作用
    expect(store.patch({})).toEqual(again)
    expect(store.persistedKeys()).toEqual(['savePath'])
  })

  it('未知字段 → ApiError(UNKNOWN_CONFIG_FIELD, invalid, 400)', () => {
    const { repo } = setup()
    const store = ConfigStore.load(repo, defaultAppConfig())

    const err = capture(() => store.patch({ nope: 1 }))
    expect(err).toBeInstanceOf(ApiError)
    const apiErr = err as ApiError
    expect(apiErr.code).toBe('UNKNOWN_CONFIG_FIELD')
    expect(apiErr.kind).toBe('invalid')
    expect(apiErr.httpStatus).toBe(400)

    // 拒绝后配置与库都没有变化
    expect(store.get()).toEqual(defaultAppConfig())
    expect(store.persistedKeys()).toEqual([])
  })

  it('多个未知字段会在消息里全部列出', () => {
    const { repo } = setup()
    const store = ConfigStore.load(repo, defaultAppConfig())

    const err = capture(() => store.patch({ foo: 1, bar: 2 })) as ApiError
    expect(err.message).toContain('foo')
    expect(err.message).toContain('bar')
  })

  it('非对象请求体 → ApiError(INVALID_CONFIG)', () => {
    const { repo } = setup()
    const store = ConfigStore.load(repo, defaultAppConfig())

    for (const bad of [null, [1, 2], 'x', 42]) {
      const err = capture(() => store.patch(bad)) as ApiError
      expect(err).toBeInstanceOf(ApiError)
      expect(err.code).toBe('INVALID_CONFIG')
      expect(err.httpStatus).toBe(400)
    }
  })

  it('取值非法时抛 ZodError，且内存缓存与库都保持原样', () => {
    const { repo } = setup()
    const store = ConfigStore.load(repo, defaultAppConfig())

    expect(() => store.patch({ downloadPoolSize: 99 })).toThrowError(ZodError)
    expect(store.get()).toEqual(defaultAppConfig())
    expect(repo.all()).toEqual({})
  })

  it('数组字段的变更也能落库并读回', () => {
    const { repo } = setup()
    const defaults = defaultAppConfig()
    const store = ConfigStore.load(repo, defaults)

    store.patch({ videoCodecPriority: ['avc'] })

    expect(repo.get('videoCodecPriority')).toBe(JSON.stringify(['avc']))
    expect(ConfigStore.load(repo, defaults).get().videoCodecPriority).toEqual(['avc'])
  })
})
