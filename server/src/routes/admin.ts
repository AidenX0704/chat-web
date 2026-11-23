import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import type { GuestLogRepo } from '../db/guestLogs.js'
import type { GuestPolicyRepo } from '../db/guestPolicy.js'
import type { GuestQuotaRepo } from '../db/guestQuota.js'
import { badRequest, notFound } from '../lib/errors.js'

const policyPatchSchema = z.object({
  enabled: z.boolean().optional(),
  dailyMessages: z.number().int().min(0).max(10000).optional(),
  allowAttachments: z.boolean().optional(),
  allowSearch: z.boolean().optional(),
  allowThinking: z.boolean().optional(),
})

const ipRulePatchSchema = z.object({
  dailyLimit: z.number().int().min(0).max(10000).nullable().optional(),
  blocked: z.boolean().optional(),
  note: z.string().max(200).optional(),
})

export type AdminRoutesOptions = {
  policy: GuestPolicyRepo
  quota: GuestQuotaRepo
  guestLogs: GuestLogRepo
}

/**
 * 管理员后台接口：严格要求已登录（系统只有 .env 里的唯一管理员账号）。
 * 用于实时调控访客免费对话策略、管理访客 IP 额度/封禁，以及审计免登录会话详情。
 */
export const adminRoutes: FastifyPluginAsync<AdminRoutesOptions> = async (
  app,
  { policy, quota, guestLogs }
) => {
  app.addHook('preHandler', app.authenticate)

  /** 概览统计 + 当前策略 */
  app.get('/api/admin/overview', async (_request, reply) => {
    const now = Date.now()
    const currentPolicy = policy.get()
    const usageToday = quota.todayTotals(now)
    const logStats = guestLogs.stats(now)
    reply.header('cache-control', 'no-store')
    return {
      policy: currentPolicy,
      stats: {
        todayMessages: Math.max(usageToday.total, logStats.todayMessages),
        todayIps: Math.max(usageToday.ips, logStats.todayIps),
        totalMessages: logStats.totalMessages,
        totalIps: logStats.totalIps,
        totalSessions: logStats.totalSessions,
        totalInputTokens: logStats.totalInputTokens,
        totalOutputTokens: logStats.totalOutputTokens,
      },
    }
  })

  /** 获取访客策略 */
  app.get('/api/admin/policy', async (_request, reply) => {
    reply.header('cache-control', 'no-store')
    return { policy: policy.get() }
  })

  /** 更新访客策略（即时生效、持久化落库） */
  app.patch('/api/admin/policy', async (request, reply) => {
    const parsed = policyPatchSchema.safeParse(request.body)
    if (!parsed.success) {
      throw badRequest('invalid_policy', '策略参数不合法')
    }
    const updated = policy.update(parsed.data, Date.now())
    reply.header('cache-control', 'no-store')
    return { policy: updated }
  })

  /** 访客 IP 列表（合并日志汇总 + 今日用量 + 单 IP 覆盖规则） */
  app.get<{ Querystring: { search?: string } }>('/api/admin/visitors', async (request, reply) => {
    const now = Date.now()
    const currentPolicy = policy.get()
    const logSummaries = guestLogs.listVisitorStats()
    const todayRows = quota.listDay(now)
    const rules = policy.listIpRules()

    const byIp = new Map<
      string,
      {
        ip: string
        todayUsed: number
        effectiveLimit: number
        customLimit: number | null
        blocked: boolean
        note: string
        totalMessages: number
        sessionCount: number
        lastActiveAt: number
        lastUserAgent: string | null
        lastQuestion: string
      }
    >()

    const ensure = (ip: string) => {
      let item = byIp.get(ip)
      if (!item) {
        item = {
          ip,
          todayUsed: 0,
          effectiveLimit: currentPolicy.enabled ? currentPolicy.dailyMessages : 0,
          customLimit: null,
          blocked: false,
          note: '',
          totalMessages: 0,
          sessionCount: 0,
          lastActiveAt: 0,
          lastUserAgent: null,
          lastQuestion: '',
        }
        byIp.set(ip, item)
      }
      return item
    }

    for (const row of logSummaries) {
      const item = ensure(row.ip)
      item.totalMessages = row.totalMessages
      item.sessionCount = row.sessionCount
      item.lastActiveAt = Math.max(item.lastActiveAt, row.lastActiveAt)
      item.lastUserAgent = row.lastUserAgent
      item.lastQuestion = row.lastQuestion
    }

    for (const row of todayRows) {
      const item = ensure(row.ip)
      item.todayUsed = row.messages
      item.lastActiveAt = Math.max(item.lastActiveAt, row.updated_at)
      if (item.totalMessages < row.messages) {
        item.totalMessages = row.messages
      }
    }

    for (const rule of rules) {
      const item = ensure(rule.ip)
      item.customLimit = rule.dailyLimit
      item.blocked = rule.blocked
      item.note = rule.note
      item.effectiveLimit =
        !currentPolicy.enabled || rule.blocked
          ? 0
          : (rule.dailyLimit ?? currentPolicy.dailyMessages)
      item.lastActiveAt = Math.max(item.lastActiveAt, rule.updatedAt)
    }

    const search = (request.query.search ?? '').trim().toLowerCase()
    const visitors = [...byIp.values()]
      .filter((item) => {
        if (search === '') {
          return true
        }
        return (
          item.ip.toLowerCase().includes(search) ||
          item.note.toLowerCase().includes(search) ||
          item.lastQuestion.toLowerCase().includes(search)
        )
      })
      .sort((a, b) => b.lastActiveAt - a.lastActiveAt)

    reply.header('cache-control', 'no-store')
    return { visitors, policy: currentPolicy }
  })

  /** 修改指定 IP 的自定义限额、封禁状态或备注 */
  app.patch<{ Params: { ip: string } }>('/api/admin/visitors/:ip', async (request, reply) => {
    const ip = decodeURIComponent(request.params.ip).trim()
    if (ip === '' || ip.length > 64) {
      throw badRequest('invalid_ip', 'IP 地址不合法')
    }
    const parsed = ipRulePatchSchema.safeParse(request.body)
    if (!parsed.success) {
      throw badRequest('invalid_ip_rule', 'IP 规则参数不合法')
    }
    const rule = policy.setIpRule(ip, parsed.data, Date.now())
    reply.header('cache-control', 'no-store')
    return { rule }
  })

  /** 重置指定 IP 今日已用免费对话次数 */
  app.post<{ Params: { ip: string } }>('/api/admin/visitors/:ip/reset', async (request, reply) => {
    const ip = decodeURIComponent(request.params.ip).trim()
    if (ip === '' || ip.length > 64) {
      throw badRequest('invalid_ip', 'IP 地址不合法')
    }
    quota.resetIp(ip, Date.now())
    reply.header('cache-control', 'no-store')
    return { ok: true, ip }
  })

  /** 清空指定 IP 的访客会话日志 */
  app.delete<{ Params: { ip: string } }>('/api/admin/visitors/:ip/logs', async (request, reply) => {
    const ip = decodeURIComponent(request.params.ip).trim()
    if (ip === '' || ip.length > 64) {
      throw badRequest('invalid_ip', 'IP 地址不合法')
    }
    const deleted = guestLogs.removeByIp(ip)
    reply.header('cache-control', 'no-store')
    return { deleted }
  })

  /** 查询免登录会话详情日志（支持按 IP / 会话 ID / 关键词过滤与分页） */
  app.get<{
    Querystring: {
      ip?: string
      sessionId?: string
      search?: string
      offset?: string
      limit?: string
    }
  }>('/api/admin/logs', async (request, reply) => {
    const offset = request.query.offset !== undefined ? Number(request.query.offset) : 0
    const limit = request.query.limit !== undefined ? Number(request.query.limit) : 30
    if (!Number.isFinite(offset) || offset < 0 || !Number.isFinite(limit) || limit < 1) {
      throw badRequest('invalid_pagination', '分页参数不合法')
    }
    const result = guestLogs.list({
      ip: request.query.ip,
      sessionId: request.query.sessionId,
      search: request.query.search,
      offset,
      limit,
    })
    reply.header('cache-control', 'no-store')
    return result
  })

  /** 删除单条访客日志 */
  app.delete<{ Params: { id: string } }>('/api/admin/logs/:id', async (request, reply) => {
    const removed = guestLogs.remove(request.params.id)
    if (!removed) {
      throw notFound('log_not_found', '日志记录不存在')
    }
    reply.code(204)
    return null
  })

  /** 清空全部访客会话日志 */
  app.delete('/api/admin/logs', async (_request, reply) => {
    const deleted = guestLogs.clearAll()
    reply.header('cache-control', 'no-store')
    return { deleted }
  })
}
