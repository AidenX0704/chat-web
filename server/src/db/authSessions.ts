import type { Database } from './types.js'

export type SessionRow = {
  id: string
  user_id: string
  token_hash: string
  created_at: number
  last_used_at: number
  expires_at: number
  revoked_at: number | null
  ip: string | null
  user_agent: string | null
}

export type ActiveSessionRow = SessionRow & {
  username: string
  user_status: 'active' | 'disabled'
  password_changed_at: number
  user_avatar: string | null
}

export type AuthSessionRepo = ReturnType<typeof createAuthSessionRepo>

export const createAuthSessionRepo = (db: Database) => {
  const insert = db.prepare(
    `INSERT INTO auth_sessions (id, user_id, token_hash, created_at, last_used_at, expires_at, revoked_at, ip, user_agent)
     VALUES (@id, @userId, @tokenHash, @now, @now, @expiresAt, NULL, @ip, @userAgent)`
  )
  const selectActiveByToken = db.prepare<[string, number], ActiveSessionRow>(
    `SELECT s.*, u.username AS username, u.status AS user_status, u.password_changed_at AS password_changed_at, u.avatar AS user_avatar
       FROM auth_sessions s
       JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ? AND s.revoked_at IS NULL AND s.expires_at > ?`
  )
  const touch = db.prepare<[number, number, string]>(
    'UPDATE auth_sessions SET last_used_at = ?, expires_at = ? WHERE id = ?'
  )
  const revokeOne = db.prepare<[number, string]>(
    'UPDATE auth_sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL'
  )
  const revokeOthers = db.prepare<[number, string, string]>(
    'UPDATE auth_sessions SET revoked_at = ? WHERE user_id = ? AND id <> ? AND revoked_at IS NULL'
  )
  const revokeAll = db.prepare<[number, string]>(
    'UPDATE auth_sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL'
  )
  const listByUser = db.prepare<[string, number], SessionRow>(
    `SELECT * FROM auth_sessions
      WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ?
      ORDER BY last_used_at DESC`
  )
  const countActive = db.prepare<[string, number], { total: number }>(
    'SELECT COUNT(*) AS total FROM auth_sessions WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ?'
  )
  const oldestActive = db.prepare<[string, number], { id: string }>(
    `SELECT id FROM auth_sessions
      WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ?
      ORDER BY last_used_at ASC LIMIT 1`
  )
  const pruneExpired = db.prepare<[number]>(
    'DELETE FROM auth_sessions WHERE expires_at <= ? OR revoked_at IS NOT NULL'
  )

  return {
    create(input: {
      id: string
      userId: string
      tokenHash: string
      now: number
      expiresAt: number
      ip: string | null
      userAgent: string | null
    }): void {
      insert.run(input)
    },
    findActiveByTokenHash(tokenHash: string, at: number): ActiveSessionRow | undefined {
      return selectActiveByToken.get(tokenHash, at)
    },
    touch(id: string, at: number, expiresAt: number): void {
      touch.run(at, expiresAt, id)
    },
    revoke(id: string, at: number): void {
      revokeOne.run(at, id)
    },
    revokeOthers(userId: string, keepSessionId: string, at: number): number {
      return revokeOthers.run(at, userId, keepSessionId).changes
    },
    revokeAll(userId: string, at: number): number {
      return revokeAll.run(at, userId).changes
    },
    listByUser(userId: string, at: number): SessionRow[] {
      return listByUser.all(userId, at)
    },
    countActive(userId: string, at: number): number {
      return countActive.get(userId, at)?.total ?? 0
    },
    oldestActiveId(userId: string, at: number): string | undefined {
      return oldestActive.get(userId, at)?.id
    },
    prune(at: number): number {
      return pruneExpired.run(at).changes
    },
  }
}
