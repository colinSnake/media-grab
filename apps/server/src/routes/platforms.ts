import { platformCatalog } from '@mediagrab/shared'
import type { FastifyPluginAsync } from 'fastify'
import type { Services } from '../services.js'

export interface PlatformRoutesDeps { services: Services }

export const platformRoutes: FastifyPluginAsync<PlatformRoutesDeps> = async (app, opts) => {
  app.get('/api/platforms', async () => {
    const extractor = await opts.services.media.extractorStatus()
    return {
      extractor,
      platforms: platformCatalog.map((item) => ({
        ...item,
        ready: item.platform === 'bilibili' || extractor.available,
        reason: item.platform === 'bilibili' || extractor.available ? '' : '需要 yt-dlp extractor',
      })),
    }
  })
}
