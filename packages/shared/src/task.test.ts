import { describe, expect, it } from 'vitest'
import { taskDedupeKey, type TaskSnapshot } from './task.js'

function task(overrides: Partial<TaskSnapshot> = {}): Pick<TaskSnapshot, 'platform' | 'sourceId' | 'input' | 'bvid' | 'cid' | 'qn' | 'streamId' | 'mode' | 'audioContainer'> {
  return {
    platform: 'bilibili',
    sourceId: 'BV1test',
    input: 'https://www.bilibili.com/video/BV1test',
    bvid: 'BV1test',
    cid: 1,
    qn: 64,
    streamId: undefined,
    mode: 'video+audio',
    audioContainer: 'm4a',
    ...overrides,
  }
}

describe('taskDedupeKey', () => {
  it('keeps different video resolutions separate', () => {
    expect(taskDedupeKey(task({ qn: 64 }))).not.toBe(taskDedupeKey(task({ qn: 80 })))
  })

  it('ignores audio container for video outputs', () => {
    expect(taskDedupeKey(task({ audioContainer: 'm4a' }))).toBe(taskDedupeKey(task({ audioContainer: 'mp3' })))
  })

  it('normalizes omitted audio container to m4a', () => {
    expect(taskDedupeKey(task({ mode: 'audio', qn: undefined, streamId: 'audio-1', audioContainer: undefined })))
      .toBe(taskDedupeKey(task({ mode: 'audio', qn: undefined, streamId: 'audio-1', audioContainer: 'm4a' })))
  })

  it('keeps different generic streams separate', () => {
    expect(taskDedupeKey(task({ platform: 'douyin', sourceId: 'item-1', qn: undefined, streamId: 'video-1' })))
      .not.toBe(taskDedupeKey(task({ platform: 'douyin', sourceId: 'item-1', qn: undefined, streamId: 'video-2' })))
  })
})
