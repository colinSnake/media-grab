import { createTaskRequestSchema } from '@mediagrab/shared'
import { createReadStream, existsSync } from 'node:fs'
import type { FastifyPluginAsync } from 'fastify'
import { ApiError } from '../lib/errors.js'
import { parseBody } from '../lib/validate.js'
import type { Services } from '../services.js'
import { resolveDownloadDir } from '../paths.js'
import path from 'node:path'

export interface TaskRoutesDeps { services: Services }

function idFromParams(params: unknown): string {
  if (typeof params !== 'object' || params === null || !('id' in params)) {
    throw new ApiError('INVALID_TASK_ID', '任务 ID 不正确', 'invalid', 400)
  }
  const id = (params as { id?: unknown }).id
  if (typeof id !== 'string' || id.trim() === '') throw new ApiError('INVALID_TASK_ID', '任务 ID 不正确', 'invalid', 400)
  return id
}

function taskFilePath(fileName: string, savePath: string, outputDir?: string): string | undefined {
  if (fileName === '' || fileName === '.' || fileName === '..' || path.basename(fileName) !== fileName) return undefined
  const candidates = [
    path.join(outputDir ?? resolveDownloadDir(savePath), fileName),
    // 仅旧任务需要兼容修复前以 apps/server 为 cwd 生成的文件。
    ...(outputDir === undefined ? [path.resolve(process.cwd(), savePath, fileName)] : []),
  ]
  return candidates.find((candidate) => existsSync(candidate))
}

export const taskRoutes: FastifyPluginAsync<TaskRoutesDeps> = async (app, opts) => {
  app.get('/api/tasks', async () => opts.services.downloads.list())

  app.get('/api/tasks/:id/file', async (req, reply) => {
    const task = opts.services.downloads.get(idFromParams(req.params))
    if (task === null) throw new ApiError('TASK_NOT_FOUND', '任务不存在', 'notFound', 404)
    const kind = (req.query as { kind?: string }).kind
    if (kind !== undefined && !['video', 'audio', 'image'].includes(kind)) throw new ApiError('INVALID_FILE_KIND', '文件类型不正确', 'invalid', 400)
    const fileName = kind === undefined ? task.fileName : task.files.find((file) => file.kind === kind)?.fileName ?? ''
    if (task.status !== 'success' || fileName === '') throw new ApiError('FILE_NOT_READY', '文件尚未准备好', 'notFound', 404)
    const filePath = taskFilePath(fileName, opts.services.config.get().savePath, task.outputDir)
    if (filePath === undefined) throw new ApiError('FILE_NOT_FOUND', '下载文件不存在，请重新下载', 'notFound', 404)
    const encodedName = encodeURIComponent(fileName)
    return reply
      .header('Content-Disposition', `attachment; filename="download"; filename*=UTF-8''${encodedName}`)
      .type('application/octet-stream')
      .send(createReadStream(filePath))
  })

  app.get('/api/tasks/:id', async (req) => {
    const task = opts.services.downloads.get(idFromParams(req.params))
    if (task === null) throw new ApiError('TASK_NOT_FOUND', '任务不存在', 'notFound', 404)
    return task
  })

  app.post('/api/tasks', async (req, reply) => {
    const body = parseBody(createTaskRequestSchema, req.body)
    const task = await opts.services.downloads.create(body)
    return reply.status(202).send(task)
  })

  app.post('/api/tasks/:id/cancel', async (req) => {
    const task = opts.services.downloads.cancel(idFromParams(req.params))
    if (task === null) throw new ApiError('TASK_NOT_FOUND', '任务不存在', 'notFound', 404)
    return task
  })

  app.post('/api/tasks/:id/start', async (req) => {
    const task = opts.services.downloads.start(idFromParams(req.params))
    if (task === null) throw new ApiError('TASK_NOT_FOUND', '任务不存在', 'notFound', 404)
    return task
  })

  app.post('/api/tasks/:id/retry', async (req) => {
    const task = opts.services.downloads.retry(idFromParams(req.params))
    if (task === null) throw new ApiError('TASK_NOT_FOUND', '任务不存在', 'notFound', 404)
    return task
  })

  app.delete('/api/tasks/:id', async (req, reply) => {
    const removed = await opts.services.downloads.remove(idFromParams(req.params))
    if (!removed) throw new ApiError('TASK_NOT_REMOVABLE', '任务不存在', 'notFound', 404)
    return reply.status(204).send()
  })

  app.get('/api/ffmpeg/check', async () => opts.services.downloads.ffmpegStatus())
}
