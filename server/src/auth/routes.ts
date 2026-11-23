import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import type { Config } from '../config.js'
import type { ChatEventHub } from '../lib/chatEvents.js'
import { badRequest, forbidden, tooManyRequests, unauthorized } from '../lib/errors.js'
import { now } from '../lib/time.js'
import type { AuthService, SessionGrant } from './service.js'

/** 校验失败时返回机器可读的 code，前端据此显示本地化文案 */
const VALIDATION_MESSAGES: Record<string, string> = {
  username_required: '请输入用户名',
  username_too_long: '用户名过长',
  password_required: '请输入密码',
  password_too_long: '密码过长',
}

/** 用户名不在本地校验字符集：账号只有一个，格式问题统一由「用户名或密码不正确」兜住 */
const usernameSchema = z.string().trim().min(1, 'username_required').max(64, 'username_too_long')

const passwordSchema = z.string().min(1, 'password_required').max(128, 'password_too_long')

const loginBody = z.object({
  username: usernameSchema,
  password: passwordSchema,
})

/** 头像 Data URL 格式：前端裁切后导出的 png / jpeg / webp base64，限制 256KB */
const AVATAR_DATA_URL_RE = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/
const AVATAR_MAX_LENGTH = 262_144

const avatarBody = z.object({
  avatar: z.string().nullable(),
})

const parseBody = <T>(schema: z.ZodType<T>, data: unknown): T => {
  const result = schema.safeParse(data)
  if (!result.success) {
    const code = result.error.issues[0]?.message ?? 'invalid_request'
    throw badRequest(code, VALIDATION_MESSAGES[code] ?? '请求参数不正确')
  }
  return result.data
}

/** 客户端用 x-session-mode: bearer 显式声明使用令牌而非 Cookie（跨站部署时用） */
const wantsTokenInBody = (mode: unknown): boolean => mode === 'bearer'

export type AuthRoutesOptions = {
  service: AuthService
  config: Config
  hub?: ChatEventHub
}

export const authRoutes: FastifyPluginAsync<AuthRoutesOptions> = async (app, options) => {
  const { service, config, hub } = options

  const sessionPayload = (
    reply: FastifyReply,
    request: FastifyRequest,
    grant: SessionGrant,
    at: number
  ): { sessionId: string; expiresAt: number; token?: string } => {
    if (wantsTokenInBody(request.headers['x-session-mode'])) {
      // 显式要求令牌时不下发 Cookie，避免两套凭据同时生效
      return { sessionId: grant.sessionId, expiresAt: grant.expiresAt, token: grant.token }
    }
    reply.setCookie(config.cookieName, grant.token, {
      path: '/',
      httpOnly: true,
      secure: config.cookieSecure,
      sameSite: config.cookieSameSite,
      domain: config.cookieDomain,
      maxAge: Math.max(1, Math.floor((grant.expiresAt - at) / 1000)),
    })
    return { sessionId: grant.sessionId, expiresAt: grant.expiresAt }
  }

  const requestMeta = (request: FastifyRequest) => {
    const agent = request.headers['user-agent']
    return {
      ip: request.ip || null,
      userAgent: typeof agent === 'string' ? agent.slice(0, 255) : null,
    }
  }

  /** 登录会触发口令散列（CPU 密集），按来源 IP 限流 */
  const loginRateLimit = {
    max: config.authRateLimit.max,
    timeWindow: config.authRateLimit.windowMs,
    keyGenerator: (request: FastifyRequest) => `login:${request.ip}`,
  }

  app.post(
    '/login',
    { config: { rateLimit: loginRateLimit } },
    async (request, reply: FastifyReply) => {
      const body = parseBody(loginBody, request.body)
      const at = now()
      const result = await service.login(
        { username: body.username, password: body.password },
        requestMeta(request),
        at
      )
      reply.header('cache-control', 'no-store')
      if (!result.ok) {
        if (result.reason === 'locked') {
          reply.header('retry-after', String(Math.ceil(result.retryAfterMs / 1000)))
          throw tooManyRequests('密码错误次数过多，请稍后再试', result.retryAfterMs)
        }
        if (result.reason === 'disabled') {
          throw forbidden('account_disabled', '账号已被停用，请联系管理员')
        }
        // 账号不存在与密码错误返回完全相同的响应，避免被用来枚举账号
        throw unauthorized('用户名或密码不正确')
      }
      return { user: result.user, session: sessionPayload(reply, request, result.grant, at) }
    }
  )

  app.post('/logout', { preHandler: app.authenticate }, async (request, reply) => {
    if (request.authSessionId) {
      service.logout(request.authSessionId, now())
      hub?.disconnectSession(request.authSessionId)
    }
    reply.clearCookie(config.cookieName, { path: '/' })
    reply.header('cache-control', 'no-store')
    reply.code(204)
    return null
  })

  app.get('/me', { preHandler: app.authenticate }, async (request) => ({
    user: request.authUser,
    session: { expiresAt: request.authExpiresAt },
  }))

  app.put('/avatar', { preHandler: app.authenticate }, async (request, reply) => {
    const user = request.authUser
    if (!user) {
      throw unauthorized()
    }
    const body = parseBody(avatarBody, request.body)
    if (body.avatar !== null) {
      if (body.avatar.length > AVATAR_MAX_LENGTH || !AVATAR_DATA_URL_RE.test(body.avatar)) {
        throw badRequest('invalid_avatar', '头像格式不正确或体积过大')
      }
    }
    const updated = service.updateAvatar(user.id, body.avatar, now())
    reply.header('cache-control', 'no-store')
    return { user: updated }
  })

  app.get('/sessions', { preHandler: app.authenticate }, async (request) => {
    const user = request.authUser
    if (!user || !request.authSessionId) {
      throw unauthorized()
    }
    return { sessions: service.listSessions(user.id, request.authSessionId, now()) }
  })

  app.delete<{ Params: { id: string } }>(
    '/sessions/:id',
    { preHandler: app.authenticate },
    async (request, reply) => {
      const user = request.authUser
      if (!user) {
        throw unauthorized()
      }
      service.revokeSession(user.id, request.params.id, now())
      hub?.disconnectSession(request.params.id)
      reply.code(204)
      return null
    }
  )

  /** 退出其他所有设备 */
  app.delete('/sessions', { preHandler: app.authenticate }, async (request) => {
    const user = request.authUser
    const sessionId = request.authSessionId
    if (!user || !sessionId) {
      throw unauthorized()
    }
    const revoked = service.revokeOtherSessions(user.id, sessionId, now())
    hub?.disconnectOtherSessions(user.id, sessionId)
    return { revoked }
  })
}
