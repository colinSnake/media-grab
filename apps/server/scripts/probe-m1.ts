/**
 * M1-9 实测脚本：**用真实匿名请求**验证免登解析链路，并回填 RISK-CONTROL 的「⚠️ 待实测」条目。
 *
 * 运行（会真实访问 api.bilibili.com，全程限速 ≥300ms）：
 *   pnpm --filter @mediagrab/server probe:m1
 *   pnpm --filter @mediagrab/server probe:m1 -- --count=10   # 少打几个请求
 *
 * 设计要点：
 * - 每次都用**全新的临时数据库**，等价于"删库 + 无任何凭据"的干净环境（风控清单第 1 项）；
 * - 所有请求走真实 `bili/http.ts`（令牌桶 + 错误分类 + 退避），不是另写一套 curl；
 * - 只做只读的匿名请求，不涉及任何账号凭据。
 */

import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { defaultAppConfig, FNVAL_MAX, QN, type QualityAvailability } from '@mediagrab/shared'
import { createServices, initializeBili } from '../src/services.js'
import { DEFAULT_USER_AGENT } from '../src/bili/http.js'
import { PLAYURL_WBI_URL } from '../src/bili/playurl.js'
import { signWbiParams } from '../src/bili/wbi.js'
import { ApiError } from '../src/lib/errors.js'

const BVID = 'BV1GJ411x7h7'
const CID = 137649199
const SHORT_LINK = 'https://b23.tv/BV1GJ411x7h7'

const args = new Map(
  process.argv
    .slice(2)
    .filter((item) => item.startsWith('--'))
    .map((item) => {
      const [key, value = 'true'] = item.replace(/^--/, '').split('=')
      return [key ?? '', value] as const
    }),
)
const floodCount = Number(args.get('count') ?? 50)
const skipFlood = args.get('skip-flood') === 'true'

const results: Array<{ name: string; ok: boolean; detail: string }> = []
function check(name: string, ok: boolean, detail: string): void {
  results.push({ name, ok, detail })
  console.log(`${ok ? '✅' : '❌'} ${name}\n   ${detail}`)
}

function describeQualities(list: readonly QualityAvailability[]): string {
  return list
    .map((item) => `${item.qn}${item.available ? '(可下)' : `(${item.state})`}`)
    .join(' ')
}

async function main(): Promise<void> {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'mediaGrab-m1-'))
  const dbPath = path.join(dataDir, 'probe.db')
  console.log('=== M1 免登解析链路实测 ===')
  console.log(`时间: ${new Date().toISOString()}`)
  console.log(`干净环境: ${dbPath}（临时目录，跑完删除）\n`)

  const services = createServices({
    config: defaultAppConfig(),
    dbPath,
    logger: {
      debug: () => {},
      info: (obj) => console.log('   [log]', JSON.stringify(obj)),
      warn: (obj) => console.log('   [warn]', JSON.stringify(obj)),
      error: (obj) => console.log('   [error]', JSON.stringify(obj)),
    },
  })

  try {
    /* 1. 指纹 + 票据（免登） */
    console.log('--- 1. 设备指纹与 bili_ticket（免登） ---')
    const init = await initializeBili(services)
    const device = services.fingerprint.overview()
    check(
      'buvid3 / buvid4 / b_nut 首次获取并落盘',
      device.present && device.bNut !== null,
      `buvid3=${device.buvid3Prefix}… buvid4=${device.buvid4Prefix}… b_nut=${device.bNut} source=${device.source}`,
    )
    check(
      'bili_ticket 免登可得性（RISK §3.3 待实测项）',
      init.ticketAvailable,
      init.ticketAvailable
        ? `可得：ticket=${device.ticket.ticket} 有效期至 ${new Date((device.ticket.expireAt ?? 0) * 1000).toISOString()}`
        : '不可得（按设计不阻塞功能，仅依赖指纹 + 限速）',
    )
    check(
      '指纹落盘后重启复用（不重新申请）',
      services.device.get()?.buvid3 === services.fingerprint.current()?.buvid3,
      `库内 buvid3 与内存一致；source=${device.source}`,
    )

    /* 2. WBI 签名与时钟校正 */
    console.log('\n--- 2. WBI 签名与时钟校正（ADR-10） ---')
    const keys = await services.wbi.refresh()
    check(
      'WBI key 从 nav 取得（匿名 nav 返回 -101 但下发 wbi_img）',
      keys.mixinKey.length === 32,
      `imgKey=${keys.imgKey} subKey=${keys.subKey} mixinKey=${keys.mixinKey}`,
    )
    check(
      '时钟偏差估算自响应 Date 头',
      Math.abs(services.clock.offsetMs) < 60_000,
      `offsetMs=${services.clock.offsetMs}（本机与 B站服务器差值）`,
    )

    /* 3. 免登解析 */
    console.log('\n--- 3. 免登解析（风控清单第 1 项） ---')
    const parsed = await services.bili.parse(BVID)
    check(
      '零凭据解析成功（视频信息 + 分P）',
      parsed.bvid === BVID && parsed.pages.length > 0,
      `title=${parsed.title} owner=${parsed.ownerName} pages=${parsed.pages.length} cid=${parsed.cid}`,
    )
    const delivered = parsed.qualities.filter((item) => item.available).map((item) => item.qn)
    check(
      '档位可用性以实际交付为准（ADR-12：不得用 accept_quality）',
      delivered.length > 0 && parsed.qualities.every((item) => !item.available || item.reason === ''),
      `可用=${delivered.join(',')}；全部=${describeQualities(parsed.qualities)}`,
    )
    check(
      '未交付的 720P/1080P 标注为登录/会员，不阻塞下载',
      parsed.qualities.filter((item) => item.qn >= 64).every((item) => !item.available),
      parsed.qualities
        .filter((item) => !item.available)
        .map((item) => `${item.qn}→${item.state}(${item.reason})`)
        .join(' '),
    )
    check(
      '音频档位（匿名 64K/132K/192K）',
      parsed.audioQualities.filter((item) => item.available).length >= 1,
      parsed.audioQualities
        .map((item) => `${item.id}${item.available ? '✅' : `(${item.state})`}`)
        .join(' '),
    )

    /* 4. 取流候选 + 防盗链 */
    console.log('\n--- 4. 取流与防盗链 ---')
    const bundle = await services.bili.playurl(BVID, parsed.cid)
    check(
      'dash 流候选带可直接下载的 URL',
      bundle.video.length > 0 && bundle.audio.length > 0,
      `video=${bundle.video.map((item) => `${item.id}/${item.codecid}`).join(' ')} audio=${bundle.audio.map((item) => item.id).join(' ')} urlTtlSec=${bundle.urlTtlSec}`,
    )
    const streamUrl = bundle.video[0]?.url
    if (streamUrl === undefined) {
      check('带 Referer 可直接取流（不被 403）', false, '没有可用的视频流地址')
    } else {
      // 按 RISK §3.5：取流必须带视频页 Referer 且 UA 非空，否则 403
      const streamResponse = await fetch(streamUrl, {
        headers: {
          'User-Agent': DEFAULT_USER_AGENT,
          Referer: `https://www.bilibili.com/video/${BVID}`,
          Range: 'bytes=0-1023',
        },
        redirect: 'follow',
      }).catch((err: unknown) => err)
      if (streamResponse instanceof Response) {
        check(
          '带 Referer 可直接取流（不被 403）',
          streamResponse.status === 206 || streamResponse.status === 200,
          `HTTP ${streamResponse.status} content-length=${streamResponse.headers.get('content-length') ?? '-'}`,
        )
        await streamResponse.body?.cancel()
      } else {
        check('带 Referer 可直接取流（不被 403）', false, String(streamResponse))
      }
    }

    /* 5. b23.tv 短链 */
    console.log('\n--- 5. b23.tv 短链归一化（FR-01） ---')
    try {
      const resolved = await services.bili.resolveInput(SHORT_LINK)
      check(
        '短链跟随跳转并归一化为 bvid',
        resolved.ref && 'bvid' in resolved.ref && resolved.ref.bvid === BVID,
        JSON.stringify(resolved.ref),
      )
    } catch (err) {
      check('短链跟随跳转并归一化为 bvid', false, err instanceof Error ? err.message : String(err))
    }

    /* 6. 连续匿名 playurl 是否触发 -412（风控清单第 4 项） */
    console.log(`\n--- 6. 连续 ${floodCount} 次匿名 playurl（≥300ms 间隔） ---`)
    if (skipFlood) {
      console.log('   （已按 --skip-flood 跳过）')
    } else {
      let riskFailures = 0
      let otherFailures = 0
      const startedAt = Date.now()
      for (let index = 0; index < floodCount; index += 1) {
        try {
          await services.bili.playurl(BVID, parsed.cid)
        } catch (err) {
          if (err instanceof ApiError && err.kind === 'risk') riskFailures += 1
          else otherFailures += 1
          console.log(`   #${index + 1} 失败: ${err instanceof Error ? err.message : String(err)}`)
        }
        if ((index + 1) % 10 === 0) {
          console.log(`   ...${index + 1}/${floodCount} 已完成（${Math.round((Date.now() - startedAt) / 1000)}s）`)
        }
      }
      check(
        `连续 ${floodCount} 次匿名 playurl 不触发 -412`,
        riskFailures === 0,
        `风控失败=${riskFailures} 其它失败=${otherFailures} 用时=${Math.round((Date.now() - startedAt) / 1000)}s`,
      )
    }

    /* 7. 跨天 WBI：清掉 key 后重取（模拟跨天首请求） */
    console.log('\n--- 7. 跨天 WBI key 重取（风控清单第 8 项） ---')
    services.wbiKeys.clear()
    const refetched = await services.wbi.get()
    const afterRefetch = await services.bili.playurl(BVID, parsed.cid)
    check(
      '清空 key 后自动重取，签名请求仍然成功',
      refetched.mixinKey.length === 32 && afterRefetch.video.length > 0,
      `新 mixinKey=${refetched.mixinKey} 取流候选=${afterRefetch.video.length}`,
    )

    /* 8. 本机时钟调偏 +5 分钟（风控清单第 7 项） */
    console.log('\n--- 8. 本机时钟调偏 +5 分钟（风控清单第 7 项） ---')
    const SKEW_MS = 5 * 60 * 1000
    // 不动机器系统时钟：给服务注入一个"快了 5 分钟"的时间源，等价于时钟调偏场景，
    // 但不会影响本机其它进程（也就不会把开发机搞出别的怪问题）。
    const skewed = createServices({
      config: defaultAppConfig(),
      dbPath: path.join(dataDir, 'skewed.db'),
      now: () => Date.now() + SKEW_MS,
    })
    try {
      await initializeBili(skewed)
      const skewedBundle = await skewed.bili.playurl(BVID, parsed.cid)
      const correctedGapSec = Math.abs(skewed.clock.nowSec() - Math.floor(Date.now() / 1000))
      check(
        '本机时钟 +5 分钟时 WBI 签名仍成功（时钟校正生效）',
        skewedBundle.video.length > 0 &&
          Math.abs(skewed.clock.offsetMs + SKEW_MS) < 30_000 &&
          correctedGapSec <= 5,
        `估算偏差=${skewed.clock.offsetMs}ms（本机快了 5 分钟）→ 校正后与真实时间相差 ${correctedGapSec}s；候选取流=${skewedBundle.video.length}`,
      )

      // 反证：用**未校正**的本机时间签名，看服务端如何响应（记录结论，不作为通过条件）
      const skewedKeys = await skewed.wbi.get()
      const badWts = Math.floor((Date.now() + SKEW_MS) / 1000)
      const badQuery = signWbiParams(
        { bvid: BVID, cid: parsed.cid, qn: QN.Q8K, fnval: FNVAL_MAX, fnver: 0, fourk: 1 },
        skewedKeys.mixinKey,
        badWts,
      ).query
      let counterfactual: string
      try {
        const raw = await skewed.http.text(`${PLAYURL_WBI_URL}?${badQuery}`, {
          class: 'playurl',
          referer: `https://www.bilibili.com/video/${BVID}`,
          label: 'probe:uncorrected-wts',
        })
        const code = (JSON.parse(raw.text) as { code?: number }).code
        counterfactual = `HTTP ${raw.status} code=${code}`
      } catch (err) {
        counterfactual =
          err instanceof ApiError
            ? `${err.code}（kind=${err.kind}, biliCode=${err.biliCode}）`
            : String(err)
      }
      console.log(`   · 反证（故意用未校正的 wts 签名）：${counterfactual}`)
    } finally {
      skewed.close()
    }

    /* 9. 无凭据落盘检查 */
    console.log('\n--- 9. 零凭据落盘检查（RISK §1.5） ---')
    const dump = JSON.stringify({
      device: services.db.prepare('SELECT * FROM device').all(),
      settings: services.db.prepare('SELECT * FROM settings').all(),
      wbi: services.db.prepare('SELECT * FROM wbi_keys').all(),
    })
    check(
      '库中不含任何账号凭据（SESSDATA / bili_jct 等）',
      !dump.includes('SESSDATA') && !dump.includes('bili_jct'),
      `device/settings/wbi_keys 三表字段：${Object.keys(services.device.get() ?? {}).join(',')}`,
    )
  } finally {
    services.close()
    if (existsSync(dataDir)) rmSync(dataDir, { recursive: true, force: true })
  }

  const failed = results.filter((item) => !item.ok)
  console.log(`\n=== 汇总：${results.length - failed.length}/${results.length} 项通过 ===`)
  if (failed.length > 0) {
    for (const item of failed) console.log(`❌ ${item.name}: ${item.detail}`)
    process.exitCode = 1
  }
}

await main()
