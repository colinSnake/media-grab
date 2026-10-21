import type { FastifyPluginAsync } from 'fastify'
import { ApiError } from '../lib/errors.js'
import { describeValidationError } from '../lib/validate.js'
import type { ConfigStore } from '../lib/config-store.js'

export interface ConfigDeps {
  store: ConfigStore
  onConfigChanged?: () => void
}

export const configRoutes: FastifyPluginAsync<ConfigDeps> = async (app, opts) => {
  app.get('/api/config', async () => opts.store.get())

  app.patch('/api/config', async (req) => {
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
