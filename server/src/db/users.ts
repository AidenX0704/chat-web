import type { Database } from './types.js'

export type UserRow = {
  id: string
  username: string
  username_normalized: string
  /** 个人账号的口令散列由 .env 派生，登录只比对内存里的散列，这一列仅作留痕 */
  password_hash: string
  status: 'active' | 'disabled'
  created_at: number
  updated_at: number
  password_changed_at: number
  last_login_at: number | null
  avatar: string | null
}

/** 对外可见的用户信息，绝不包含密码散列。 */
export type PublicUser = {
  id: string
  username: string
  status: 'active' | 'disabled'
  createdAt: number
  passwordChangedAt: number
  lastLoginAt: number | null
  avatar: string | null
}

export const toPublicUser = (row: UserRow): PublicUser => ({
  id: row.id,
  username: row.username,
  status: row.status,
  createdAt: row.created_at,
  passwordChangedAt: row.password_changed_at,
  lastLoginAt: row.last_login_at,
  avatar: row.avatar ?? null,
})

/** 用户名只保留一个规范化形式用于查重：去空格、大小写折叠。 */
export const normalizeUsername = (username: string): string => username.trim().toLowerCase()

export type UserRepo = ReturnType<typeof createUserRepo>

/** users 表现在只承载「会话/附件归属的 user_id」，账号本身由 .env 决定 */
export const createUserRepo = (db: Database) => {
  const selectByNormalized = db.prepare<[string], UserRow>(
    'SELECT * FROM users WHERE username_normalized = ?'
  )
  const selectById = db.prepare<[string], UserRow>('SELECT * FROM users WHERE id = ?')
  const insert = db.prepare(
    `INSERT INTO users (id, username, username_normalized, password_hash, status, created_at, updated_at, password_changed_at, last_login_at)
     VALUES (@id, @username, @usernameNormalized, @passwordHash, @status, @now, @now, @now, NULL)`
  )
  const updatePersonal = db.prepare(
    `UPDATE users
     SET username = @username, username_normalized = @usernameNormalized, password_hash = @passwordHash,
         status = 'active', updated_at = @now
     WHERE id = @id`
  )
  const updateAvatarStmt = db.prepare<[string | null, number, string]>(
    'UPDATE users SET avatar = ?, updated_at = ? WHERE id = ?'
  )

  return {
    findByUsername(username: string): UserRow | undefined {
      return selectByNormalized.get(normalizeUsername(username))
    },
    findById(id: string): UserRow | undefined {
      return selectById.get(id)
    },
    updateAvatar(id: string, avatar: string | null, now: number): UserRow | undefined {
      const result = updateAvatarStmt.run(avatar, now, id)
      if (result.changes === 0) {
        return undefined
      }
      return selectById.get(id)
    },
    /**
     * 同步 .env 里的唯一账号：已有同名账号沿用原 id，保证历史会话与附件不丢；
     * 没有则新建。返回最新的行。
     */
    upsertPersonal(input: {
      id: string
      username: string
      passwordHash: string
      now: number
    }): UserRow {
      const existing = selectByNormalized.get(normalizeUsername(input.username))
      if (existing === undefined) {
        insert.run({
          id: input.id,
          username: input.username,
          usernameNormalized: normalizeUsername(input.username),
          passwordHash: input.passwordHash,
          status: 'active',
          now: input.now,
        })
        return selectById.get(input.id) as UserRow
      }
      updatePersonal.run({
        id: existing.id,
        username: input.username,
        usernameNormalized: normalizeUsername(input.username),
        passwordHash: input.passwordHash,
        now: input.now,
      })
      return selectById.get(existing.id) as UserRow
    },
  }
}
