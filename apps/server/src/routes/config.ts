import type { FastifyPluginAsync } from 'fastify'
import { ApiError } from '../lib/errors.js'
import { describeValidationError } from '../lib/validate.js'
import type { ConfigStore } from '../lib/config-store.js'

export interface ConfigDeps {
  store: ConfigStore
  onConfigChanged?: () => void
  desktopCore?: boolean
}

export const configRoutes: FastifyPluginAsync<ConfigDeps> = async (app, opts) => {
  app.get('/api/config', async () => opts.store.get())

  app.patch('/api/config', async (req) => {
    if (opts.desktopCore && req.body !== null && typeof req.body === 'object' && !Array.isArray(req.body) &&
        ('serverPort' in req.body || 'bindHost' in req.body)) {
      throw new ApiError('DESKTOP_LISTEN_LOCKED', '桌面版服务固定使用 127.0.0.1:9070', 'invalid', 400)
    }
    try {
      const config = opts.store.patch(req.body ?? {})
      opts.onConfigChanged?.()
      return config
    } catch (err) {
      if (err instanceof ApiError) throw err
      throw new ApiError('INVALID_CONFIG', describeValidationError(err), 'invalid', 400)
    }
  })
}
