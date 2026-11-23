import type { FastifyPluginAsync } from 'fastify'
import type { Config } from '../config.js'

export const healthRoutes: FastifyPluginAsync<{ config: Config; startedAt: number }> = async (
  app,
  { config, startedAt }
) => {
  app.get('/api/health', async () => ({
    status: 'ok',
    env: config.env,
    uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
    chatProxy: config.chatProxy.enabled,
  }))
}
