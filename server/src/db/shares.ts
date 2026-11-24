import { randomBytes } from 'node:crypto'
import type { Database } from './types.js'

/**
 * 分享令牌：160 位随机数，走 base64url，长度 32。
 * 分享页不要求登录，令牌本身就是唯一凭据，所以必须足够长、不可猜。
 */
const createShareToken = (): string => randomBytes(20).toString('base64url')

/** 令牌形状校验：不合形状的请求不查库，也挡住扫描器构造的怪路径 */
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{16,64}$/

export const isShareToken = (value: string): boolean => TOKEN_PATTERN.test(value)

export type ShareRow = {
  token: string
  user_id: string
  chat_id: string
  title: string
  data: string
  created_at: number
  updated_at: number
}

export type ShareRepo = ReturnType<typeof createShareRepo>

/**
 * 会话分享链接。
 *
 * 每个会话只保留一条分享记录、一个固定令牌：再次分享时刷新内容快照并沿用旧令牌，
 * 链接不会越攒越多，之前发出去的链接也仍然可用（拿到的是最新内容）。
 * 快照存在 data 里，分享页因此不依赖会话的后续修改，消息被删也不会变成空白页。
 */
export const createShareRepo = (db: Database) => {
  const selectByToken = db.prepare<[string], ShareRow>('SELECT * FROM chat_shares WHERE token = ?')
  const selectByChat = db.prepare<[string, string], ShareRow>(
    'SELECT * FROM chat_shares WHERE user_id = ? AND chat_id = ?'
  )
  const insert = db.prepare(
    `INSERT INTO chat_shares (token, user_id, chat_id, title, data, created_at, updated_at)
     VALUES (@token, @userId, @chatId, @title, @data, @at, @at)`
  )
  const refresh = db.prepare<{ token: string; title: string; data: string; at: number }>(
    'UPDATE chat_shares SET title = @title, data = @data, updated_at = @at WHERE token = @token'
  )
  const deleteByChat = db.prepare<[string, string]>(
    'DELETE FROM chat_shares WHERE user_id = ? AND chat_id = ?'
  )
  const deleteOne = db.prepare<[string, string]>(
    'DELETE FROM chat_shares WHERE token = ? AND user_id = ?'
  )
  const countByUser = db.prepare<[string], { total: number }>(
    'SELECT COUNT(*) AS total FROM chat_shares WHERE user_id = ?'
  )
  const selectByUser = db.prepare<[string], ShareRow>(
    'SELECT * FROM chat_shares WHERE user_id = ? ORDER BY updated_at DESC'
  )

  return {
    get(token: string): ShareRow | null {
      return selectByToken.get(token) ?? null
    },
    findByChat(userId: string, chatId: string): ShareRow | null {
      return selectByChat.get(userId, chatId) ?? null
    },
    /** 生成或刷新分享链接：已存在时沿用原令牌 */
    save(input: {
      userId: string
      chatId: string
      title: string
      data: string
      at: number
    }): ShareRow {
      const existing = selectByChat.get(input.userId, input.chatId)
      if (existing) {
        refresh.run({ token: existing.token, title: input.title, data: input.data, at: input.at })
        return { ...existing, title: input.title, data: input.data, updated_at: input.at }
      }
      const token = createShareToken()
      insert.run({ token, ...input })
      return {
        token,
        user_id: input.userId,
        chat_id: input.chatId,
        title: input.title,
        data: input.data,
        created_at: input.at,
        updated_at: input.at,
      }
    },
    removeByChat(userId: string, chatId: string): number {
      return deleteByChat.run(userId, chatId).changes
    },
    remove(token: string, userId: string): number {
      return deleteOne.run(token, userId).changes
    },
    countByUser(userId: string): number {
      return countByUser.get(userId)?.total ?? 0
    },
    /** 某个用户名下的全部分享链接，最近刷新的排前面 */
    listByUser(userId: string): ShareRow[] {
      return selectByUser.all(userId)
    },
  }
}
