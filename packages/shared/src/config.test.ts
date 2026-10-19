import { describe, expect, it } from 'vitest'
import {
  CODEC_ID,
  appConfigSchema,
  defaultAppConfig,
  mergeAppConfig,
  needsFfmpegTranscode,
} from './config.js'
import {
  createTaskRequestSchema,
  isCancellable,
  isTerminal,
  taskProgress,
  wsMessageSchema,
} from './task.js'

describe('配置', () => {
  it('零参数即得完整默认配置，且默认只监听本机回环', () => {
    const cfg = defaultAppConfig()
    expect(cfg.serverPort).toBe(8787)
    expect(cfg.bindHost).toBe('127.0.0.1')
    expect(cfg.defaultDownloadMode).toBe('video+audio')
    expect(cfg.audioContainer).toBe('m4a')
    expect(cfg.videoCodecPriority).toEqual(['hevc', 'avc', 'av1'])
  })

  it('拒绝非法端口与非法下载模式', () => {
    expect(() => appConfigSchema.parse({ serverPort: 70000 })).toThrow()
    expect(() => appConfigSchema.parse({ defaultDownloadMode: 'both' })).toThrow()
  })

  it('局部更新只覆盖传入字段', () => {
    const merged = mergeAppConfig(defaultAppConfig(), {
      audioContainer: 'mp3',
      savePath: '/tmp/dl',
    })
    expect(merged.audioContainer).toBe('mp3')
    expect(merged.savePath).toBe('/tmp/dl')
    expect(merged.serverPort).toBe(8787)
  })

  it('未知字段被丢弃，不会污染配置', () => {
    const merged = mergeAppConfig(defaultAppConfig(), { evil: 1 })
    expect(Object.keys(merged)).not.toContain('evil')
  })

  it('只有 audio + mp3 需要 ffmpeg 转码', () => {
    expect(needsFfmpegTranscode('audio', 'mp3')).toBe(true)
    expect(needsFfmpegTranscode('audio', 'm4a')).toBe(false)
    expect(needsFfmpegTranscode('video+audio', 'mp3')).toBe(false)
  })

  it('编码名映射到 B站 codecid', () => {
    expect(CODEC_ID.hevc).toBe(12)
    expect(CODEC_ID.avc).toBe(7)
    expect(CODEC_ID.av1).toBe(13)
  })
})

describe('任务模型', () => {
  it('新建任务默认走视频+音频', () => {
    const req = createTaskRequestSchema.parse({ bvid: 'BV1GJ411x7h7', cid: 1 })
    expect(req.mode).toBe('video+audio')
  })

  it('可以只下音频', () => {
    const req = createTaskRequestSchema.parse({
      bvid: 'BV1GJ411x7h7',
      cid: 1,
      mode: 'audio',
      audioContainer: 'm4a',
    })
    expect(req.mode).toBe('audio')
    expect(req.qn).toBeUndefined()
  })

  it('拒绝非法 bvid', () => {
    expect(() => createTaskRequestSchema.parse({ bvid: 'av12345', cid: 1 })).toThrow()
  })

  it('进度计算，总长未知时返回 0', () => {
    expect(taskProgress({ totalBytes: 200, downloadedBytes: 50 })).toBeCloseTo(0.25)
    expect(taskProgress({ totalBytes: 0, downloadedBytes: 50 })).toBe(0)
  })

  it('终态与可取消状态判断', () => {
    expect(isCancellable('downloading')).toBe(true)
    expect(isCancellable('success')).toBe(false)
    expect(isTerminal('stopped')).toBe(true)
    expect(isTerminal('downloading')).toBe(false)
  })

  it('WS 消息可按判别联合解析', () => {
    const msg = wsMessageSchema.parse({ type: 'task-removed', id: 'x' })
    expect(msg.type).toBe('task-removed')
  })
})
