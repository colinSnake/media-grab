import { describe, expect, it } from 'vitest'
import { upscaleCreateSchema, upscaleFileNameSchema } from './upscale.js'

describe('upscale output file names', () => {
  it.each([
    ['难却-2x', '难却-2x.mp4'],
    ['  难却-2x  ', '难却-2x.mp4'],
    ['  难却-2x.mp4  ', '难却-2x.mp4'],
    ['难却-2x.MP4', '难却-2x.MP4'],
    ['歌词（增强版）', '歌词（增强版）.mp4'],
  ])('normalizes %s to %s', (input, expected) => {
    expect(upscaleFileNameSchema.parse(input)).toBe(expected)
    expect(upscaleCreateSchema.parse({ grant: 'f6bf36b6-33af-477b-aef5-5b7c369bdb16', fileName: input }).fileName).toBe(expected)
    expect(upscaleFileNameSchema.parse(expected)).toBe(expected)
  })
  it('accepts the real Chinese source title and its generated output name', () => {
    const title = '【Hi-Res无损】平生不晚《难却》百听不厌的古风歌曲｜歌词纯享版「待上浓妆好戏开场 台上悲欢皆我独吟唱」-video-anime-2x.mp4'
    expect(upscaleFileNameSchema.parse(title)).toBe(title)
  })
  it.each([
    ['', '请输入输出文件名'], ['   ', '请输入输出文件名'],
    ['../output', '目录'], ['/tmp/output.mp4', '目录'], ['a\\b.mp4', '目录'],
    ['.hidden', '点开头'], ['.mp4', '点开头'],
    ['output.mov', 'MP4'], ['output.mp3', 'MP4'],
    ['name\n.mp4', '控制字符'], ['name.mp4\n', '控制字符'], ['name\0.mp4', '控制字符'],
  ])('rejects %j with an actionable message', (input, message) => {
    const result = upscaleFileNameSchema.safeParse(input)
    expect(result.success).toBe(false)
    if (!result.success) expect(result.error.issues[0]?.message).toContain(message)
  })
  it('applies UTF-8 and character limits after adding the extension', () => {
    expect(upscaleFileNameSchema.safeParse('中'.repeat(79)).success).toBe(false)
    expect(upscaleFileNameSchema.parse('中'.repeat(78))).toBe('中'.repeat(78) + '.mp4')
    expect(upscaleFileNameSchema.safeParse('é'.repeat(80)).success).toBe(false)
    expect(upscaleFileNameSchema.safeParse('a'.repeat(177)).success).toBe(false)
  })
})
