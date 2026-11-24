import type { Config } from '../config.js'
import type { AuthEventRepo } from '../db/authEvents.js'
import type { AuthSessionRepo, SessionRow } from '../db/authSessions.js'
import type { ThrottleRepo } from '../db/throttle.js'
import { toPublicUser, type PublicUser, type UserRepo } from '../db/users.js'
import type { PersonalAccount } from './account.js'
import { forbidden, unauthorized } from '../lib/errors.js'
import { createId, createSessionToken, hashSessionToken } from './tokens.js'

/** 每次使用都写库会放大写锁竞争：一分钟内的多次请求只顺延一次。 */
const TOUCH_INTERVAL_MS = 60 * 1000

export type AuthMeta = {
  ip: string | null
  userAgent: string | null
}

export type SessionGrant = {
  token: string
  sessionId: string
  expiresAt: number
}

export type LoginResult =
  | { ok: true; user: PublicUser; grant: SessionGrant }
  | { ok: false; reason: 'invalid' | 'disabled' | 'locked'; retryAfterMs: number }

export type AuthenticatedCaller = {
  user: PublicUser
  sessionId: string
  expiresAt: number
}

export type AuthService = ReturnType<typeof createAuthService>

type Deps = {
  config: Config
  account: PersonalAccount
  users: UserRepo
  sessions: AuthSessionRepo
  throttle: ThrottleRepo
  events: AuthEventRepo
}

const scopeForUser = (username: string) => `user:${username.trim().toLowerCase()}`
const scopeForIp = (ip: string | null) => (ip === null ? null : `ip:${ip}`)

export const createAuthService = ({ config, account, users, sessions, throttle, events }: Deps) => {
  const issueSession = (userId: string, meta: AuthMeta, at: number): SessionGrant => {
    const token = createSessionToken()
    const sessionId = createId()
    const expiresAt = at + config.sessionTtlMs
    sessions.create({
      id: sessionId,
      userId,
      tokenHash: hashSessionToken(token),
      now: at,
      expiresAt,
      ip: meta.ip,
      userAgent: meta.userAgent,
    })
    // 超过设备数量上限时，淘汰最久未使用的一台，避免令牌无限堆积
    let active = sessions.countActive(userId, at)
    while (active > config.maxSessionsPerUser) {
      const oldest = sessions.oldestActiveId(userId, at)
      if (oldest === undefined || oldest === sessionId) {
        break
      }
      sessions.revoke(oldest, at)
      active -= 1
    }
    return { token, sessionId, expiresAt }
  }

  const resolveExpiry = (row: SessionRow): number => {
    const absolute = row.created_at + config.sessionTtlMs
    const sliding = row.last_used_at + config.sessionIdleMs
    return Math.min(absolute, sliding)
  }

  return {
    /**
     * 唯一账号登录：凭据只跟 .env 比，库里查不到「另一个账号」也就无从注册。
     * 失败与成功都走同一套限流，配合 Retry-After 挡住撞库。
     */
    async login(
      input: { username: string; password: string },
      meta: AuthMeta,
      at: number
    ): Promise<LoginResult> {
      const userScope = scopeForUser(input.username)
      const ipScope = scopeForIp(meta.ip)
      const userLocked = throttle.lockedForMs(userScope, at)
      const ipLocked = ipScope === null ? 0 : throttle.lockedForMs(ipScope, at)
      const lockedForMs = Math.max(userLocked, ipLocked)
      if (lockedForMs > 0) {
        events.record({
          type: 'login_locked',
          at,
          username: input.username,
          ip: meta.ip,
          detail: `retry_after_ms=${lockedForMs}`,
        })
        return { ok: false, reason: 'locked', retryAfterMs: lockedForMs }
      }

      const user = account.user
      const ok = await account.verify(input.username, input.password)
      if (!ok) {
        const failure = throttle.registerFailure(userScope, at)
        if (ipScope !== null) {
          throttle.registerFailure(ipScope, at)
        }
        events.record({
          type: 'login_failed',
          at,
          userId: user.id,
          username: input.username,
          ip: meta.ip,
          detail: 'bad_credentials',
        })
        return {
          ok: false,
          reason: failure.lockedForMs > 0 ? 'locked' : 'invalid',
          retryAfterMs: failure.lockedForMs,
        }
      }

      if (user.status !== 'active') {
        events.record({
          type: 'login_failed',
          at,
          userId: user.id,
          username: user.username,
          ip: meta.ip,
          detail: 'disabled',
        })
        return { ok: false, reason: 'disabled', retryAfterMs: 0 }
      }

      throttle.reset(userScope)
      if (ipScope !== null) {
        throttle.reset(ipScope)
      }
      events.record({ type: 'login', at, userId: user.id, username: user.username, ip: meta.ip })
      const freshRow = users.findById(user.id)
      const latestUser = freshRow ? toPublicUser(freshRow) : user
      return { ok: true, user: latestUser, grant: issueSession(user.id, meta, at) }
    },

    /** 校验令牌并顺延有效期；无效返回 undefined（不抛错，交给路由层决定响应）。 */
    authenticateToken(token: string, at: number): AuthenticatedCaller | undefined {
      const row = sessions.findActiveByTokenHash(hashSessionToken(token), at)
      if (!row || row.user_status !== 'active') {
        return undefined
      }
      const expiresAt = resolveExpiry(row)
      if (expiresAt <= at) {
        return undefined
      }
      if (at - row.last_used_at >= TOUCH_INTERVAL_MS) {
        sessions.touch(row.id, at, expiresAt)
      }
      return {
        user: {
          id: row.user_id,
          username: row.username,
          status: row.user_status,
          createdAt: row.created_at,
          passwordChangedAt: row.password_changed_at,
          lastLoginAt: null,
          avatar: row.user_avatar ?? null,
        },
        sessionId: row.id,
        expiresAt,
      }
    },

    updateAvatar(userId: string, avatar: string | null, at: number): PublicUser {
      const updated = users.updateAvatar(userId, avatar, at)
      if (!updated) {
        throw unauthorized()
      }
      return toPublicUser(updated)
    },

    logout(sessionId: string, at: number): void {
      sessions.revoke(sessionId, at)
      events.record({ type: 'logout', at, detail: `session=${sessionId}` })
    },

    listSessions(userId: string, currentSessionId: string, at: number) {
      return sessions.listByUser(userId, at).map((row) => ({
        id: row.id,
        createdAt: row.created_at,
        lastUsedAt: row.last_used_at,
        expiresAt: row.expires_at,
        ip: row.ip,
        userAgent: row.user_agent,
        current: row.id === currentSessionId,
      }))
    },

    revokeSession(userId: string, sessionId: string, at: number): void {
      const mine = sessions.listByUser(userId, at).some((row) => row.id === sessionId)
      if (!mine) {
        throw forbidden('session_not_found', '会话不存在或已失效')
      }
      sessions.revoke(sessionId, at)
      events.record({ type: 'session_revoked', at, userId, detail: `session=${sessionId}` })
    },

    revokeOtherSessions(userId: string, keepSessionId: string, at: number): number {
      const revoked = sessions.revokeOthers(userId, keepSessionId, at)
      events.record({ type: 'session_revoked', at, userId, detail: `revoked=${revoked}` })
      return revoked
    },
  }
}
