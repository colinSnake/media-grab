import { beforeEach, describe, expect, it, vi } from 'vitest'
import { BiliClient } from './client.js'
import { fetchPlayurl } from './playurl.js'
import { fetchVideoDetail } from './view.js'

vi.mock('./playurl.js', () => ({
  fetchPlayurl: vi.fn(),
}))

vi.mock('./view.js', () => ({
  fetchVideoDetail: vi.fn(),
}))

const mockedFetchPlayurl = vi.mocked(fetchPlayurl)
const mockedFetchVideoDetail = vi.mocked(fetchVideoDetail)

describe('BiliClient 分P选择', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockedFetchVideoDetail.mockResolvedValue({
      bvid: 'BV1GJ411x7h7',
      avid: 100,
      cid: 111,
      title: 'multi-page',
      cover: '',
      durationSec: 20,
      owner: { mid: 1, name: 'author' },
      pages: [
        { cid: 111, page: 1, part: '第一部分', duration: 10 },
        { cid: 222, page: 2, part: '第二部分', duration: 20 },
      ],
    })
    mockedFetchPlayurl.mockResolvedValue({
      bvid: 'BV1GJ411x7h7',
      cid: 222,
      durationSec: 20,
      session: { loggedIn: false, vip: false },
      qualities: [],
      audioQualities: [],
      video: [],
      audio: [],
      urlTtlSec: 7200,
    })
  })

  it('解析指定分P时把对应 cid 传给取流接口', async () => {
    const client = new BiliClient({ http: {} as never, wbi: {} as never, fingerprint: {} as never })

    const result = await client.parse('BV1GJ411x7h7', 2)

    expect(result.page).toBe(2)
    expect(result.cid).toBe(222)
    expect(result.durationSec).toBe(20)
    expect(mockedFetchPlayurl).toHaveBeenCalledWith({}, {}, {
      bvid: 'BV1GJ411x7h7',
      cid: 222,
      session: { loggedIn: false, vip: false },
    })
  })

  it('请求不存在的分P时返回明确错误', async () => {
    const client = new BiliClient({ http: {} as never, wbi: {} as never, fingerprint: {} as never })

    await expect(client.parse('BV1GJ411x7h7', 3)).rejects.toMatchObject({ code: 'PAGE_NOT_FOUND' })
    expect(mockedFetchPlayurl).not.toHaveBeenCalled()
  })
})
