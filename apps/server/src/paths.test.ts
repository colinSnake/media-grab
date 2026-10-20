import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveDownloadDir } from './paths.js'

describe('resolveDownloadDir', () => {
  it('expands the default Downloads directory under the current user home', () => {
    expect(resolveDownloadDir('~/Downloads/mediaGrab', '/tmp/mediaGrab-test'))
      .toBe(path.join(os.homedir(), 'Downloads', 'mediaGrab'))
  })

  it('preserves configured absolute directories', () => {
    expect(resolveDownloadDir('/tmp/mediaGrab-downloads', '/tmp/mediaGrab-test'))
      .toBe('/tmp/mediaGrab-downloads')
  })
})
