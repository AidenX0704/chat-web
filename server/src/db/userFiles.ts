import type { Database } from './types.js'

export type UserFileRow = {
  user_id: string
  id: string
  size: number
  mime: string
  created_at: number
}

export type UserFileRepo = ReturnType<typeof createUserFileRepo>

export const createUserFileRepo = (db: Database) => {
  const select = db.prepare<[string, string], UserFileRow>(
    'SELECT * FROM user_files WHERE user_id = ? AND id = ?'
  )
  const upsert = db.prepare(
    `INSERT INTO user_files (user_id, id, size, mime, created_at)
     VALUES (@userId, @id, @size, @mime, @at)
     ON CONFLICT(user_id, id) DO UPDATE SET size = @size, mime = @mime`
  )
  const remove = db.prepare<[string, string]>('DELETE FROM user_files WHERE user_id = ? AND id = ?')
  const totalSize = db.prepare<[string], { total: number }>(
    'SELECT COALESCE(SUM(size), 0) AS total FROM user_files WHERE user_id = ?'
  )
  const listOrphans = db.prepare<[number], UserFileRow>(
    `SELECT f.* FROM user_files f
      WHERE f.created_at < ?
        AND NOT EXISTS (
          SELECT 1 FROM chat_files c WHERE c.user_id = f.user_id AND c.file_id = f.id
        )
      LIMIT 500`
  )
  const sizeOf = db.prepare<[string, string], { size: number }>(
    'SELECT size FROM user_files WHERE user_id = ? AND id = ?'
  )

  return {
    get(userId: string, id: string): UserFileRow | undefined {
      return select.get(userId, id)
    },
    put(input: { userId: string; id: string; size: number; mime: string; at: number }): void {
      upsert.run(input)
    },
    remove(userId: string, id: string): void {
      remove.run(userId, id)
    },
    totalSize(userId: string): number {
      return totalSize.get(userId)?.total ?? 0
    },
    /** 一天内仍没有任何会话引用的原件 */
    listOrphans(olderThan: number): UserFileRow[] {
      return listOrphans.all(olderThan)
    },
    sizeOf(userId: string, id: string): number {
      return sizeOf.get(userId, id)?.size ?? 0
    },
  }
}
