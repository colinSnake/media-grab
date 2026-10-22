import { describe, expect, it } from 'vitest'
import { MediaRegistry } from './registry.js'

function registry(): MediaRegistry {
  return new MediaRegistry({
    bili: {} as never,
    config: { get: () => ({ ytDlpPath: '' }) } as never,
  })
}

describe('MediaRegistry platform readiness', () => {
  it('keeps native B站 readiness independent from yt-dlp', () => {
    expect(registry().platformReadiness('bilibili', false)).toEqual({ ready: true, reason: '' })
  })

  it('reports extractor dependency when yt-dlp is unavailable', () => {
    expect(registry().platformReadiness('douyin', false)).toEqual({ ready: false, reason: '需要 yt-dlp extractor' })
  })

  it('reports a registered extractor platform ready when the tool is available', () => {
    expect(registry().platformReadiness('youtube', true)).toEqual({ ready: true, reason: '' })
  })
})
