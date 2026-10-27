import { describe, expect, it } from 'vitest'
import { compareTaskCreation, createTaskRequestSchema, taskDedupeKey, taskSnapshotSchema, type TaskSnapshot } from './task.js'

it('parses explicitly queued requests and persists the queued status', () => {
  expect(createTaskRequestSchema.parse({ start: false, bvid: 'BV1GJ411x7h7', cid: 1 }).start).toBe(false)
  expect(taskSnapshotSchema.parse({ id: 'queued', bvid: '', cid: 0, status: 'queued', phase: 'pending', updatedAt: 1 }).status).toBe('queued')
})

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

it('reads existing single-file task snapshots without a files field', () => {
  const legacy = {
    id: 'old', platform: 'xiaohongshu', input: 'https://www.xiaohongshu.com/explore/123', sourceId: '123',
    bvid: '', cid: 0, title: 'clip', status: 'success', phase: 'done', mode: 'video+audio',
    totalBytes: 1024, downloadedBytes: 1024, speedBps: 0, fileName: 'clip.mp4', error: '', updatedAt: 1,
  }
  const parsed = taskSnapshotSchema.parse(legacy)
  expect(parsed).toMatchObject({ fileName: 'clip.mp4', files: [] })
  expect(parsed).not.toHaveProperty('transferDurationMs')
})

it('keeps creation order when an older task is updated or saved later', () => {
  const older = { id: 'older', createdAt: 100, updatedAt: 400 } as TaskSnapshot
  const newer = { id: 'newer', createdAt: 200, updatedAt: 200 } as TaskSnapshot
  expect([older, newer].sort(compareTaskCreation).map((item) => item.id)).toEqual(['newer', 'older'])
  expect([newer, { ...older, updatedAt: 900 }].sort(compareTaskCreation).map((item) => item.id)).toEqual(['newer', 'older'])
})
