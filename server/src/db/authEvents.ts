import type { Database } from './types.js'

export type AuthEventType =
  | 'login'
  | 'login_failed'
  | 'login_locked'
  | 'logout'
  | 'session_revoked'

export type AuthEventRepo = ReturnType<typeof createAuthEventRepo>

/** 审计日志：只留可判责的最小字段，不记密码、不记 token。 */
export const createAuthEventRepo = (db: Database) => {
  const insert = db.prepare(
    `INSERT INTO auth_events (at, type, user_id, username, ip, detail)
     VALUES (@at, @type, @userId, @username, @ip, @detail)`
  )
  const pruneBefore = db.prepare<[number]>('DELETE FROM auth_events WHERE at < ?')

  return {
    record(input: {
      type: AuthEventType
      at: number
      userId?: string | null
      username?: string | null
      ip?: string | null
      detail?: string | null
    }): void {
      insert.run({
        type: input.type,
        at: input.at,
        userId: input.userId ?? null,
        username: input.username ?? null,
        ip: input.ip ?? null,
        detail: input.detail ?? null,
      })
    },
    prune(at: number, retentionMs: number): number {
      return pruneBefore.run(at - retentionMs).changes
    },
  }
}
