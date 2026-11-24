import type { FastifyReply, FastifyRequest } from 'fastify'
import type { PublicUser } from '../db/users.js'

declare module 'fastify' {
  interface FastifyRequest {
    /** 已通过 authenticate 的调用者 */
    authUser?: PublicUser
    authSessionId?: string
    authExpiresAt?: number
    /** 未登录的访客请求：记录客户端 IP，用于按 IP 计每日额度并在途请求计数 */
    guestIp?: string
    /** 访客本次扣减后的额度（登录用户没有），用于回写响应头 */
    guestQuota?: { limit: number; used: number; remaining: number; resetAt: number }
  }

  interface FastifyInstance {
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>
  }
}
