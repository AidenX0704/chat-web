import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { Config } from '../config.js'
import { forbidden, unauthorized } from '../lib/errors.js'
import type { AuthService } from './service.js'

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

const readBearer = (header: string | undefined): string | null => {
  if (!header) {
    return null
  }
  const match = /^Bearer\s+(.+)$/i.exec(header.trim())
  return match?.[1]?.trim() ?? null
}

/**
 * Cookie 是浏览器自动携带的凭据，必须自己挡住 CSRF：
 * 跨站部署（SameSite=None）时要求 Origin 白名单且必须存在；
 * 同站部署时 SameSite=Lax 已能挡住跨站表单提交，这里再补一道 Origin 校验。
 */
const assertOriginAllowed = (request: FastifyRequest, config: Config): void => {
  if (SAFE_METHODS.has(request.method)) {
    return
  }
  const origin = request.headers.origin
  const strict = config.cookieSameSite === 'none' || config.corsOrigins.length > 0
  if (!origin) {
    if (config.cookieSameSite === 'none') {
      throw forbidden('csrf_origin_missing', '缺少 Origin 请求头')
    }
    return
  }
  if (config.corsOrigins.length > 0) {
    if (!config.corsOrigins.includes(origin)) {
      throw forbidden('csrf_origin_rejected', '来源不被允许')
    }
    return
  }
  if (!strict) {
    // 未配置白名单时按同源处理：Origin 的 host 必须与请求的 host 一致
    try {
      if (new URL(origin).host !== request.headers.host) {
        throw forbidden('csrf_origin_rejected', '来源不被允许')
      }
    } catch {
      throw forbidden('csrf_origin_rejected', '来源不被允许')
    }
  }
}

export type AuthenticateOptions = {
  service: AuthService
  config: Config
  clock?: () => number
}

export const createAuthenticate =
  ({ service, config, clock = Date.now }: AuthenticateOptions) =>
  async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const bearer = readBearer(request.headers.authorization)
    const cookieToken = request.cookies?.[config.cookieName] ?? null
    const token = bearer ?? cookieToken
    if (!token) {
      throw unauthorized()
    }
    const caller = service.authenticateToken(token, clock())
    if (!caller) {
      if (!bearer && cookieToken) {
        reply.clearCookie(config.cookieName, { path: '/' })
      }
      throw unauthorized()
    }
    if (!bearer && cookieToken) {
      assertOriginAllowed(request, config)
    }
    request.authUser = caller.user
    request.authSessionId = caller.sessionId
    request.authExpiresAt = caller.expiresAt
    reply.header('cache-control', 'no-store')
  }

export const registerAuthenticateDecorator = (
  app: FastifyInstance,
  options: AuthenticateOptions
): void => {
  app.decorate('authenticate', createAuthenticate(options))
}
