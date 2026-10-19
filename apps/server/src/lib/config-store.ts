import { type AppConfig, appConfigPatchSchema, mergeAppConfig } from '@mediagrab/shared'
import type { SettingsRepository } from '../store/repositories.js'
import { ApiError } from './errors.js'

/**
 * 配置持有者。
 *
 * M0 是纯内存实现，M1 起每个字段独立落库（settings 表，值为 JSON 字符串），
 * 于是"重启后配置还在"这件事由存储层保证，而调用方（路由、健康检查）无需改动 ——
 * 这正是把配置访问收敛到一个对象的原因。
 *
 * 设计取舍：
 * - 配置项**按字段**存取而不是整份 JSON：单字段损坏只回退该字段，不会连带丢掉其它配置；
 * - 内存缓存是权威读源，写完库才更新缓存，保证"写失败 = 内存不变"。
 */
export class ConfigStore {
  #repo: SettingsRepository
  #current: AppConfig
  /** settings 表中存在、且属于已知配置项的键（值是否可解析不影响，见 persistedKeys） */
  #persisted: Set<string>

  constructor(repo: SettingsRepository, initial: AppConfig) {
    this.#repo = repo
    this.#current = initial
    this.#persisted = ConfigStore.#readPersistedKeys(repo, initial)
  }

  /**
   * 从 settings 表恢复配置；缺失/损坏的字段回退默认值，不抛异常。
   *
   * 逐字段解析 + 逐字段校验：任何一项 JSON 损坏或超出取值范围都只影响它自己，
   * 其余配置照常生效（用户不该因为一个坏值丢掉整套配置）。
   */
  static load(repo: SettingsRepository, defaults: AppConfig): ConfigStore {
    const stored = repo.all()
    let config = defaults

    for (const key of Object.keys(defaults)) {
      const raw = stored[key]
      if (raw === undefined) continue

      let candidate: unknown
      try {
        candidate = JSON.parse(raw)
      } catch {
        // 非法 JSON：保持默认值（由调用方决定是否落 warn）
        continue
      }

      try {
        // 单字段走完整 schema 校验：类型错、越界、枚举不合法都退回默认值
        config = mergeAppConfig(config, { [key]: candidate })
      } catch {
        continue
      }
    }

    return new ConfigStore(repo, config)
  }

  get(): AppConfig {
    return this.#current
  }

  /**
   * 局部更新。
   *
   * 未知字段被**明确拒绝**而不是静默忽略：配置项要么被实现、要么报错，
   * 不允许出现"改了没反应"的装饰性配置（docs/PRD.md NFR-10）。
   *
   * 写入顺序：校验 → 持久化（只写真正变化的键）→ 更新内存缓存。
   * 持久化抛错时缓存保持原样，避免"内存说改了、重启后变回去"的不一致。
   */
  patch(raw: unknown): AppConfig {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new ApiError('INVALID_CONFIG', '请求体必须是 JSON 对象', 'invalid', 400)
    }
    const known = new Set(Object.keys(this.#current))
    const unknown = Object.keys(raw as Record<string, unknown>).filter((key) => !known.has(key))
    if (unknown.length > 0) {
      throw new ApiError(
        'UNKNOWN_CONFIG_FIELD',
        `不支持的配置项: ${unknown.join(', ')}`,
        'invalid',
        400,
      )
    }

    // 解析/校验失败时抛 ZodError，由路由层（routes/config.ts）转成 400 INVALID_CONFIG
    const next = mergeAppConfig(this.#current, appConfigPatchSchema.parse(raw))

    const changed: Record<string, string> = {}
    const before = this.#current as Record<string, unknown>
    const after = next as Record<string, unknown>
    for (const key of Object.keys(next)) {
      const prev = before[key]
      const value = after[key]
      // 用序列化结果比较：数组字段（编码/音质优先级）也能正确判断"是否真的变了"
      if (JSON.stringify(prev) === JSON.stringify(value)) continue
      changed[key] = JSON.stringify(value)
    }

    if (Object.keys(changed).length > 0) {
      this.#repo.setMany(changed)
    }
    this.#current = next
    for (const key of Object.keys(changed)) this.#persisted.add(key)
    return this.#current
  }

  /**
   * 当前配置中已落库的键（用于诊断/测试）。
   *
   * 语义是"settings 表里存在且属于已知配置项的键"：即使值损坏（加载时回退默认值），
   * 该键依然在库里，诊断界面需要如实反映这一点。返回字典序，便于测试与展示稳定。
   */
  persistedKeys(): string[] {
    return [...this.#persisted].sort()
  }

  /** 供构造函数复用：库中存在的已知配置键 */
  static #readPersistedKeys(repo: SettingsRepository, initial: AppConfig): Set<string> {
    const known = new Set(Object.keys(initial))
    const stored = repo.all()
    return new Set(Object.keys(stored).filter((key) => known.has(key)))
  }
}
