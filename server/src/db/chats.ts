import type { Database } from './types.js'

export type ChatRow = {
  id: string
  user_id: string
  title: string
  created_at: number
  updated_at: number
  version: number
  message_count: number
  root_message_id: string | null
}

export type ChatSummaryRow = Omit<ChatRow, 'user_id' | 'root_message_id'>

export type MessageRow = {
  id: string
  revision: number
  position: number
  role: string
  data: string
}

/** 单条消息的写入项：data 是这条消息的完整 JSON */
export type MessageInput = {
  id: string
  position: number
  role: string
  data: string
}

export type ChatPayload = {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  rootMessageId: string | null
  upsert: MessageInput[]
  deleted: string[]
}

export type WriteResult =
  | { ok: true; version: number; updatedAt: number; created: boolean; messageCount: number }
  | { ok: false; conflict: true }

export type CustomError = { code: string }

export type ChatRepo = ReturnType<typeof createChatRepo>

/**
 * 会话与消息读写。
 *
 * 消息按行存放，客户端每次只提交「新增或内容有变化的那些消息」以及「被删掉的 id」；
 * 服务端在一个事务里递增会话版本号，并给每条被写入的消息打上这个 revision。
 * 客户端拿着自己知道的版本号调增量接口，就能只取回变化的部分。
 *
 * 并发控制仍是乐观锁：`UPDATE ... WHERE version = ?` 一条语句完成校验与自增。
 */
export const createChatRepo = (db: Database) => {
  const listSummaries = db.prepare<[string], ChatSummaryRow>(
    `SELECT id, title, created_at, updated_at, version, message_count
       FROM chats WHERE user_id = ? ORDER BY updated_at DESC`
  )
  const selectOne = db.prepare<[string, string], ChatRow>(
    'SELECT * FROM chats WHERE id = ? AND user_id = ?'
  )
  const selectVersion = db.prepare<[string, string], { version: number }>(
    'SELECT version FROM chats WHERE id = ? AND user_id = ?'
  )
  const insertChat = db.prepare(
    `INSERT INTO chats (id, user_id, title, created_at, updated_at, version, message_count, root_message_id)
     VALUES (@id, @userId, @title, @createdAt, @updatedAt, @version, 0, @rootMessageId)`
  )
  const updateChat = db.prepare(
    `UPDATE chats
        SET title = @title, created_at = @createdAt, updated_at = @updatedAt,
            root_message_id = @rootMessageId, version = @version
      WHERE id = @id AND user_id = @userId`
  )
  const countMessages = db.prepare<[string, string], { total: number }>(
    'SELECT COUNT(*) AS total FROM chat_messages WHERE user_id = ? AND chat_id = ?'
  )
  const updateMessageCount = db.prepare<[number, string, string]>(
    'UPDATE chats SET message_count = ? WHERE user_id = ? AND id = ?'
  )
  const updateTitle = db.prepare<
    { id: string; userId: string; title: string; updatedAt: number },
    { version: number }
  >(
    `UPDATE chats SET title = @title, updated_at = @updatedAt, version = version + 1
      WHERE id = @id AND user_id = @userId
      RETURNING version`
  )
  const removeChat = db.prepare<[string, string]>('DELETE FROM chats WHERE id = ? AND user_id = ?')
  const countByUser = db.prepare<[string], { total: number }>(
    'SELECT COUNT(*) AS total FROM chats WHERE user_id = ?'
  )
  const selectMessages = db.prepare<[string, string], MessageRow>(
    `SELECT id, revision, position, role, data FROM chat_messages
       WHERE user_id = ? AND chat_id = ? ORDER BY position ASC, id ASC`
  )
  const selectMessagesSince = db.prepare<[string, string, number], MessageRow>(
    `SELECT id, revision, position, role, data FROM chat_messages
       WHERE user_id = ? AND chat_id = ? AND revision > ? ORDER BY position ASC, id ASC`
  )
  const upsertMessage = db.prepare(
    `INSERT INTO chat_messages (user_id, chat_id, id, revision, position, role, data)
     VALUES (@userId, @chatId, @id, @revision, @position, @role, @data)
     ON CONFLICT(user_id, chat_id, id) DO UPDATE SET
       revision = @revision, position = @position, role = @role, data = @data`
  )
  const deleteMessage = db.prepare<[string, string, string]>(
    'DELETE FROM chat_messages WHERE user_id = ? AND chat_id = ? AND id = ?'
  )
  const insertDeletion = db.prepare(
    `INSERT INTO chat_message_deletions (user_id, chat_id, id, revision, created_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(user_id, chat_id, id) DO UPDATE SET revision = excluded.revision,
       created_at = excluded.created_at`
  )
  const selectDeletionsSince = db.prepare<[string, string, number], { id: string }>(
    `SELECT id FROM chat_message_deletions
       WHERE user_id = ? AND chat_id = ? AND revision > ?`
  )
  const pruneDeletionsBefore = db.prepare<[number]>(
    'DELETE FROM chat_message_deletions WHERE created_at < ?'
  )
  const insertFileRef = db.prepare(
    'INSERT OR IGNORE INTO chat_files (user_id, chat_id, file_id) VALUES (?, ?, ?)'
  )
  const clearFileRefs = db.prepare<[string, string]>(
    'DELETE FROM chat_files WHERE user_id = ? AND chat_id = ?'
  )
  const selectFileIds = db.prepare<[string, string], { file_id: string }>(
    'SELECT file_id FROM chat_files WHERE user_id = ? AND chat_id = ?'
  )
  const fileRefCount = db.prepare<[string, string, string], { total: number }>(
    'SELECT COUNT(*) AS total FROM chat_files WHERE user_id = ? AND file_id = ? AND chat_id <> ?'
  )

  const syncFileRefs = (userId: string, chatId: string, fileIds: string[]) => {
    clearFileRefs.run(userId, chatId)
    for (const fileId of new Set(fileIds)) {
      insertFileRef.run(userId, chatId, fileId)
    }
  }

  const applyUpserts = (
    userId: string,
    chatId: string,
    revision: number,
    upsert: MessageInput[]
  ) => {
    for (const message of upsert) {
      upsertMessage.run({
        userId,
        chatId,
        id: message.id,
        revision,
        position: message.position,
        role: message.role,
        data: message.data,
      })
    }
  }

  const write = (
    userId: string,
    payload: ChatPayload,
    baseVersion: number | null
  ): WriteResult => {
    const run = db.transaction((): WriteResult => {
      const existing = selectVersion.get(payload.id, userId)
      if (!existing) {
        insertChat.run({
          id: payload.id,
          userId,
          title: payload.title,
          createdAt: payload.createdAt,
          updatedAt: payload.updatedAt,
          version: 1,
          rootMessageId: payload.rootMessageId,
        })
        applyUpserts(userId, payload.id, 1, payload.upsert)
        for (const id of payload.deleted) {
          deleteMessage.run(userId, payload.id, id)
        }
        updateMessageCount.run(
          countMessages.get(userId, payload.id)?.total ?? 0,
          userId,
          payload.id
        )
        return {
          ok: true,
          version: 1,
          updatedAt: payload.updatedAt,
          created: true,
          messageCount: payload.upsert.length,
        }
      }
      if (baseVersion !== null && baseVersion !== existing.version) {
        return { ok: false, conflict: true }
      }
      const revision = existing.version + 1
      const updated = updateChat.run({
        id: payload.id,
        userId,
        title: payload.title,
        createdAt: payload.createdAt,
        updatedAt: payload.updatedAt,
        rootMessageId: payload.rootMessageId,
        version: revision,
      })
      if (updated.changes === 0) {
        // 校验与写入之间被别的请求抢先改了版本
        return { ok: false, conflict: true }
      }
      applyUpserts(userId, payload.id, revision, payload.upsert)
      for (const id of payload.deleted) {
        deleteMessage.run(userId, payload.id, id)
        insertDeletion.run(userId, payload.id, id, revision, Date.now())
      }
      const messageCount = countMessages.get(userId, payload.id)?.total ?? 0
      updateMessageCount.run(messageCount, userId, payload.id)
      return {
        ok: true,
        version: revision,
        updatedAt: payload.updatedAt,
        created: false,
        messageCount,
      }
    })
    return run()
  }

  return {
    listSummaries(userId: string): ChatSummaryRow[] {
      return listSummaries.all(userId)
    },
    get(userId: string, id: string): ChatRow | undefined {
      return selectOne.get(id, userId)
    },
    messages(userId: string, id: string): MessageRow[] {
      return selectMessages.all(userId, id)
    },
    /** 增量：返回 revision 大于 since 的消息与被删除的 id */
    delta(userId: string, id: string, since: number) {
      return {
        messages: selectMessagesSince.all(userId, id, since),
        deleted: selectDeletionsSince.all(userId, id, since).map((row) => row.id),
      }
    },
    write,
    rename(userId: string, id: string, title: string, at: number): { version: number } | null {
      return updateTitle.get({ id, userId, title, updatedAt: at }) ?? null
    },
    remove(userId: string, id: string): boolean {
      return removeChat.run(id, userId).changes > 0
    },
    countByUser(userId: string): number {
      return countByUser.get(userId)?.total ?? 0
    },
    fileIds(userId: string, id: string): string[] {
      return selectFileIds.all(userId, id).map((row) => row.file_id)
    },
    syncFileRefs(userId: string, chatId: string, fileIds: string[]): void {
      syncFileRefs(userId, chatId, fileIds)
    },
    fileReferenced(userId: string, fileId: string, exceptChatId: string): boolean {
      return (fileRefCount.get(userId, fileId, exceptChatId)?.total ?? 0) > 0
    },
    /** 整库替换（导入历史）：一个事务里清空并重建 */
    replaceAll(
      userId: string,
      sessions: {
        meta: {
          id: string
          title: string
          createdAt: number
          updatedAt: number
          rootMessageId: string | null
        }
        messages: MessageInput[]
        fileIds: string[]
      }[]
    ): number {
      const run = db.transaction(() => {
        db.prepare<[string]>('DELETE FROM chats WHERE user_id = ?').run(userId)
        for (const session of sessions) {
          insertChat.run({
            id: session.meta.id,
            userId,
            title: session.meta.title,
            createdAt: session.meta.createdAt,
            updatedAt: session.meta.updatedAt,
            version: 1,
            rootMessageId: session.meta.rootMessageId,
          })
          applyUpserts(userId, session.meta.id, 1, session.messages)
          updateMessageCount.run(session.messages.length, userId, session.meta.id)
          syncFileRefs(userId, session.meta.id, session.fileIds)
        }
        return sessions.length
      })
      return run()
    },
    pruneDeletions(before: number): number {
      return pruneDeletionsBefore.run(before).changes
    },
  }
}
