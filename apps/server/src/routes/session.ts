import { accountIdParamsSchema, biliAccountImportSchema, douyinCookieSchema } from '@mediagrab/shared'
import type { FastifyPluginAsync } from 'fastify'
import type { Services } from '../services.js'
import { parseBody } from '../lib/validate.js'

/**
 * 登录态摘要（TECH §6 接口清单）。
 *
 * 这里刻意不返回任何凭据内容，只返回**是否已登录**与账号/指纹摘要 ——
 * 前端永远拿不到可用于登录的东西（RISK §4）。
 */
export interface SessionRoutesDeps {
  services: Services
}

export const sessionRoutes: FastifyPluginAsync<SessionRoutesDeps> = async (app, opts) => {
  app.get('/api/session', async () => {
    const device = opts.services.fingerprint.overview()
    const account = opts.services.accountService.activeBili()
    const session = opts.services.accountService.session()
    return {
      loggedIn: session.loggedIn,
      vip: session.vip,
      anonymous: !session.loggedIn,
      loginAvailable: true,
      account: account ? {
        id: account.id,
        label: account.label,
        displayName: account.displayName,
        status: account.status,
        lastVerifiedAt: account.lastVerifiedAt,
      } : null,
      device: {
        fingerprintReady: device.present,
        buvid3Prefix: device.buvid3Prefix,
        buvid4Prefix: device.buvid4Prefix,
        source: device.source,
        ticketAvailable: device.ticket.available,
      },
    }
  })

  app.get('/api/accounts', async () => ({ accounts: opts.services.accountService.list() }))

  app.get('/api/accounts/douyin/cookie', async () => ({ configured: opts.services.accountService.douyinCookieConfigured() }))

  app.post('/api/accounts/douyin/cookie', async (req) => {
    const body = parseBody(douyinCookieSchema, req.body)
    opts.services.accountService.saveDouyinCookie(body.cookie)
    return { configured: true }
  })

  app.delete('/api/accounts/douyin/cookie', async () => {
    opts.services.accountService.clearDouyinCookie()
    return { configured: false }
  })

  app.get('/api/accounts/xiaohongshu/cookie', async () => ({ configured: opts.services.accountService.xiaohongshuCookieConfigured() }))

  app.post('/api/accounts/xiaohongshu/cookie', async (req) => {
    const body = parseBody(douyinCookieSchema, req.body)
    opts.services.accountService.saveXiaohongshuCookie(body.cookie)
    return { configured: true }
  })

  app.delete('/api/accounts/xiaohongshu/cookie', async () => {
    opts.services.accountService.clearXiaohongshuCookie()
    return { configured: false }
  })

  app.post('/api/accounts/bilibili', async (req) => {
    const body = parseBody(biliAccountImportSchema, req.body)
    return opts.services.accountService.importBili(body.label, body.cookie)
  })

  app.post('/api/accounts/:id/activate', async (req) => {
    const { id } = parseBody(accountIdParamsSchema, req.params)
    return opts.services.accountService.activate(id)
  })

  app.post('/api/accounts/:id/verify', async (req) => {
    const { id } = parseBody(accountIdParamsSchema, req.params)
    return opts.services.accountService.verify(id)
  })

  app.delete('/api/accounts/:id', async (req) => {
    const { id } = parseBody(accountIdParamsSchema, req.params)
    opts.services.accountService.remove(id)
    return { ok: true }
  })
}
