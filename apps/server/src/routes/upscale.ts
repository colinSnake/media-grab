import { timingSafeEqual } from 'node:crypto'
import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { upscaleCreateSchema } from '@mediagrab/shared'
import { repairStrokesSchema } from '@mediagrab/shared'
import type { Services } from '../services.js'
import { coreProof, matchesCoreToken } from '../lib/core-auth.js'
import { invalid } from '../upscale/service.js'

const selection = z.object({ path: z.string().min(1).max(4096), proof: z.string().regex(/^[a-f0-9]{64}$/) }).strict()
const grantSchema = z.object({ input: selection, directory: selection, kind: z.enum(['video', 'image']).default('video') }).strict()
export const upscaleRoutes: FastifyPluginAsync<{ services: Services; coreToken?: string }> = async (app, { services, coreToken }) => {
  // This local filesystem API is intentionally unavailable to unauthenticated browser deployments.
  app.addHook('onRequest', async (req, reply) => {
    if (req.url.startsWith('/api/upscale') && (!coreToken || !matchesCoreToken(coreToken, req.headers['x-mediagrab-token']))) {
      return reply.status(403).send({ error: { code: 'UPSCALE_DESKTOP_ONLY', message: '本地超分需要已验证的桌面会话', kind: 'forbidden', retryable: false } })
    }
  })
  app.get('/api/upscale/capability', async () => (await services.upscale.capabilities(true)).capability)
  app.get('/api/upscale/tasks', async () => ({ tasks: services.upscale.list(), storageReason: services.upscale.storageReason }))
  app.get<{ Params: { id: string } }>('/api/upscale/tasks/:id/thumbnail', async (req, reply) => {
    const image = await services.upscale.thumbnail(req.params.id)
    return reply.header('Cache-Control', 'no-store').header('X-Content-Type-Options', 'nosniff').type('image/png').send(image)
  })
  app.get<{ Params: { id: string } }>('/api/upscale/grants/:id/thumbnail', async (req, reply) => {
    const image = await services.upscale.grantThumbnail(req.params.id)
    return reply.header('Cache-Control', 'no-store').header('X-Content-Type-Options', 'nosniff').type('image/png').send(image)
  })
  app.post('/api/upscale/grants', async (req) => {
    const parsed = grantSchema.safeParse(req.body)
    if (!parsed.success) throw invalid('文件选择参数不合法')
    for (const selectionKind of ['input', 'directory'] as const) {
      const value = parsed.data[selectionKind]
      const expected = coreProof(coreToken!, `upscale-${selectionKind}\0${value.path}`)
      if (!timingSafeEqual(Buffer.from(expected), Buffer.from(value.proof))) throw invalid('文件必须通过原生对话框选择', 403)
    }
    return services.upscale.authorize(parsed.data.input.path, parsed.data.directory.path, parsed.data.kind)
  })
  app.post('/api/upscale/tasks', async (req) => {
    const parsed = upscaleCreateSchema.safeParse(req.body)
    if (!parsed.success) throw invalid('任务参数不合法，请检查输出文件名')
    return services.upscale.create(parsed.data)
  })
  app.post<{ Params: { id: string } }>('/api/upscale/grants/:id/repair-preview', async (req, reply) => {
    const body = z.object({ strokes: repairStrokesSchema }).strict().safeParse(req.body)
    if (!body.success) throw invalid('修补选区参数不合法')
    const abort = new AbortController()
    const disconnect = () => { if (!reply.raw.writableFinished) abort.abort() }
    req.raw.once('aborted', disconnect)
    reply.raw.once('close', disconnect)
    try {
      const image = await services.upscale.repairPreview(req.params.id, body.data.strokes, abort.signal)
      return reply.header('Cache-Control', 'no-store').header('X-Content-Type-Options', 'nosniff').type('image/png').send(image)
    } finally {
      req.raw.removeListener('aborted', disconnect)
      reply.raw.removeListener('close', disconnect)
    }
  })
  app.delete<{ Params: { id: string } }>('/api/upscale/tasks/:id', async (req, reply) => {
    await services.upscale.remove(req.params.id)
    return reply.status(204).send()
  })
  app.post<{ Params: { id: string } }>('/api/upscale/tasks/:id/cancel', async (req) => services.upscale.cancel(req.params.id))
}
