import type { FastifyPluginAsync } from 'fastify'
import type { GuestPolicyRepo } from '../db/guestPolicy.js'
import type { GuestQuotaRepo } from '../db/guestQuota.js'

export type GuestRoutesOptions = {
  quota: GuestQuotaRepo
  policy: GuestPolicyRepo
}

/**
 * 未登录访客的额度与可用功能查询。
 * 公开接口：访客界面进来及每次对话后拉取，实时反映管理员后台修改的策略与限额。
 */
export const guestRoutes: FastifyPluginAsync<GuestRoutesOptions> = async (
  app,
  { quota, policy }
) => {
  app.get('/api/guest/quota', async (request, reply) => {
    const currentPolicy = policy.get()
    const ipRule = policy.getIpRule(request.ip)
    const snap = quota.snapshot(request.ip, Date.now())
    reply.header('cache-control', 'no-store')
    return {
      guest: {
        ...snap,
        enabled: currentPolicy.enabled,
        blocked: ipRule?.blocked ?? false,
        allowAttachments: currentPolicy.enabled && !(ipRule?.blocked ?? false) && currentPolicy.allowAttachments,
        allowSearch: currentPolicy.enabled && !(ipRule?.blocked ?? false) && currentPolicy.allowSearch,
        allowThinking: currentPolicy.enabled && !(ipRule?.blocked ?? false) && currentPolicy.allowThinking,
      },
    }
  })
}
