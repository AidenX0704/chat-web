import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import type { Config } from '../config.js'
import type { ChatRepo, MessageInput } from '../db/chats.js'
import type { ShareRepo } from '../db/shares.js'
import type { UserFileRepo } from '../db/userFiles.js'
import type { ChatEventHub } from '../lib/chatEvents.js'
import { HttpError, badRequest, notFound, payloadTooLarge, unauthorized } from '../lib/errors.js'
import { isSafeId, type BlobStore } from '../storage/blobs.js'
import type { SpreadsheetStore } from '../spreadsheets/store.js'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const MAX_TITLE_LENGTH = 200
/** 一次请求里最多提交多少条消息变更 / 删除 */
const MAX_CHANGES = 5000
/** SSE 心跳间隔：让反向代理和 NAT 保持连接，也能及时发现半开连接 */
const DEFAULT_SSE_HEARTBEAT_MS = 25_000
const MAX_CLIENT_ID_LENGTH = 128

const readId = (value: unknown, code: string): string => {
  if (typeof value !== 'string' || !isSafeId(value)) {
    throw badRequest(code, 'ID 不合法')
  }
  return value
}

const readTime = (value: unknown, code: string): number => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw badRequest(code, '时间戳不合法')
  }
  return value
}

const readTitle = (value: unknown): string => {
  if (typeof value !== 'string' || value.length > MAX_TITLE_LENGTH) {
    throw badRequest('invalid_session_title', '会话标题不合法')
  }
  return value
}

const readRootId = (value: unknown): string | null => {
  if (value === null || value === undefined) {
    return null
  }
  if (typeof value !== 'string' || !isSafeId(value)) {
    throw badRequest('invalid_root_message', '根消息 ID 不合法')
  }
  return value
}

/**
 * 单条消息对服务端是不透明数据：只校验排序与识别需要的字段。
 * position 是会话内的顺序（客户端数组下标），单独传而不是塞进消息对象里，
 * 这样服务端存的 JSON 与前端 Session 类型保持完全一致。
 */
const readMessage = (value: unknown, position: number): MessageInput => {
  if (!isRecord(value)) {
    throw badRequest('invalid_message', '消息格式不正确')
  }
  const { id, role } = value
  if (typeof id !== 'string' || !isSafeId(id)) {
    throw badRequest('invalid_message_id', '消息 ID 不合法')
  }
  if (typeof role !== 'string' || role.length === 0 || role.length > 32) {
    throw badRequest('invalid_message_role', '消息角色不合法')
  }
  return { id, role, position, data: JSON.stringify(value) }
}

/** 增量保存：`[{ position, message }]`，只有内容变化的消息才需要出现 */
const readMessageChanges = (value: unknown, maxBytes: number): MessageInput[] => {
  if (value === undefined) {
    return []
  }
  if (!Array.isArray(value)) {
    throw badRequest('invalid_messages', '消息列表格式不正确')
  }
  if (value.length > MAX_CHANGES) {
    throw badRequest('too_many_changes', `一次最多提交 ${MAX_CHANGES} 条消息变更`)
  }
  const messages = value.map((item) => {
    if (!isRecord(item)) {
      throw badRequest('invalid_message', '消息格式不正确')
    }
    const position = item.position
    if (typeof position !== 'number' || !Number.isInteger(position) || position < 0) {
      throw badRequest('invalid_message_position', '消息位置不合法')
    }
    return readMessage(item.message, position)
  })
  if (Buffer.byteLength(JSON.stringify(messages), 'utf8') > maxBytes) {
    throw payloadTooLarge('本次提交的消息过大')
  }
  return messages
}

/** 整库导入：`[{...message}]`，按数组下标作为位置 */
const readPlainMessages = (value: unknown, maxBytes: number): MessageInput[] => {
  if (value === undefined) {
    return []
  }
  if (!Array.isArray(value)) {
    throw badRequest('invalid_messages', '消息列表格式不正确')
  }
  if (value.length > MAX_CHANGES) {
    throw badRequest('too_many_messages', `单个会话最多 ${MAX_CHANGES} 条消息`)
  }
  const messages = value.map((item, index) => readMessage(item, index))
  if (Buffer.byteLength(JSON.stringify(messages), 'utf8') > maxBytes) {
    throw payloadTooLarge('会话内容过大')
  }
  return messages
}

const readFileIds = (value: unknown): string[] => {
  if (value === undefined) {
    return []
  }
  if (!Array.isArray(value) || value.length > MAX_CHANGES) {
    throw badRequest('invalid_file_ids', '附件列表格式不正确')
  }
  return [...new Set(value.map((item) => readId(item, 'invalid_file_id')))]
}

const readDeletedList = (value: unknown): string[] => {
  if (value === undefined) {
    return []
  }
  if (!Array.isArray(value) || value.length > MAX_CHANGES) {
    throw badRequest('invalid_deleted', '删除列表格式不正确')
  }
  return value.map((item) => readId(item, 'invalid_message_id'))
}

const readBaseVersion = (value: unknown): number | null => {
  if (value === undefined || value === null) {
    return null
  }
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw badRequest('invalid_version', '版本号不合法')
  }
  return value
}

/**
 * 分享时可以只挑一部分消息：`messageIds` 缺省表示整段会话。
 * 只挑消息时按会话原顺序重排成单分支，否则快照里的分支指针会指向被排除的消息，分享页会在缺口处断掉。
 */
const pickSharedMessages = (messages: unknown[], ids: string[]): unknown[] => {
  const wanted = new Set(ids)
  const picked = messages.filter(
    (message) => isRecord(message) && typeof message.id === 'string' && wanted.has(message.id)
  )
  return picked.map((message, index) => {
    const previous = picked[index - 1] as { id?: string } | undefined
    const next = picked[index + 1] as { id?: string } | undefined
    return {
      ...(message as Record<string, unknown>),
      parentId: previous?.id ?? null,
      // 最后一条没有后继：JSON 序列化时丢掉这个键，读取时按「路径到此结束」处理
      selectedChildId: next?.id,
    }
  })
}

const readShareMessageIds = (value: unknown): string[] | null => {
  if (value === undefined || value === null) {
    return null
  }
  if (!Array.isArray(value)) {
    throw badRequest('invalid_message_ids', '消息列表格式不正确')
  }
  if (value.length > MAX_CHANGES) {
    throw badRequest('too_many_messages', `一次最多分享 ${MAX_CHANGES} 条消息`)
  }
  return [...new Set(value.map((item) => readId(item, 'invalid_message_id')))]
}

const readClientId = (request: FastifyRequest): string | null => {
  const raw = request.headers['x-client-id']
  if (typeof raw !== 'string') {
    return null
  }
  const value = raw.trim()
  if (value === '' || value.length > MAX_CLIENT_ID_LENGTH) {
    return null
  }
  return value
}

const parseOptionalSince = (querySince: string | undefined, lastEventId: unknown): number | null => {
  const raw =
    querySince !== undefined
      ? querySince
      : typeof lastEventId === 'string' && lastEventId.trim() !== ''
        ? lastEventId.trim()
        : undefined
  if (raw === undefined) {
    return null
  }
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 0) {
    throw badRequest('invalid_since', 'since 不合法')
  }
  return value
}

export type ChatRoutesOptions = {
  config: Config
  chats: ChatRepo
  shares: ShareRepo
  files: UserFileRepo
  blobs: BlobStore
  spreadsheets?: SpreadsheetStore
  hub: ChatEventHub
  /** SSE 保活心跳间隔（测试可传更小的值） */
  sseHeartbeatMs?: number
}

export const chatRoutes: FastifyPluginAsync<ChatRoutesOptions> = async (app, options) => {
  const {
    config,
    chats,
    shares,
    files,
    blobs,
    spreadsheets,
    hub,
    sseHeartbeatMs = DEFAULT_SSE_HEARTBEAT_MS,
  } = options

  // 插件级钩子：本组路由全部要求登录，作用域只在当前插件内
  app.addHook('preHandler', app.authenticate)

  const userIdOf = (request: FastifyRequest): string => {
    const userId = request.authUser?.id
    if (!userId) {
      throw unauthorized()
    }
    return userId
  }

  /** SSE 自己写 raw 响应，@fastify/cors 的 onSend 不会执行，按同一白名单补跨域头 */
  const corsHeadersFor = (request: FastifyRequest): Record<string, string> => {
    const origin = request.headers.origin
    if (typeof origin !== 'string' || !config.corsOrigins.includes(origin)) {
      return {}
    }
    return {
      'access-control-allow-origin': origin,
      'access-control-allow-credentials': 'true',
      vary: 'Origin',
    }
  }

  /** 删除会话后清理没有任何会话再引用的原件 */
  const dropOrphanFiles = async (userId: string, fileIds: string[], chatId: string): Promise<void> => {
    for (const fileId of fileIds) {
      if (chats.fileReferenced(userId, fileId, chatId)) {
        continue
      }
      files.remove(userId, fileId)
      await blobs.remove(userId, fileId)
      await spreadsheets?.remove(`user:${userId}`, fileId)
    }
  }

  const parseMessage = (data: string): unknown => JSON.parse(data) as unknown

  /** 侧边栏只需要元数据：标题列表单独一个接口，打开会话时再拉正文 */
  app.get('/api/chats', async (request) => {
    const userId = userIdOf(request)
    const rows = chats.listSummaries(userId)
    return {
      chats: rows.map((row) => ({
        id: row.id,
        title: row.title,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        version: row.version,
        messageCount: row.message_count,
      })),
      serverTime: Date.now(),
    }
  })

  /** 打开会话：一次拿全量消息 */
  app.get<{ Params: { id: string } }>('/api/chats/:id', async (request, reply: FastifyReply) => {
    const userId = userIdOf(request)
    const row = chats.get(userId, request.params.id)
    if (!row) {
      throw notFound('chat_not_found', '会话不存在')
    }
    const messages = chats.messages(userId, row.id).map((message) => parseMessage(message.data))
    reply.header('cache-control', 'no-store')
    return {
      chat: {
        id: row.id,
        title: row.title,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        version: row.version,
        messageCount: row.message_count,
        session: {
          id: row.id,
          title: row.title,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
          // 老数据迁移过来时根消息可能为空：有消息就取第一条，避免前端把会话当成空的
          rootMessageId:
            row.root_message_id ??
            (messages[0] as { id?: string } | undefined)?.id ??
            null,
          messages,
        },
      },
    }
  })

  /** 增量：只取 since 之后变化的消息与被删掉的 id */
  app.get<{ Params: { id: string }; Querystring: { since?: string } }>(
    '/api/chats/:id/messages',
    async (request, reply: FastifyReply) => {
      const userId = userIdOf(request)
      const row = chats.get(userId, request.params.id)
      if (!row) {
        throw notFound('chat_not_found', '会话不存在')
      }
      const since = request.query.since
      if (since === undefined) {
        throw badRequest('invalid_since', '缺少 since 参数')
      }
      const sinceVersion = Number(since)
      if (!Number.isInteger(sinceVersion) || sinceVersion < 0) {
        throw badRequest('invalid_since', 'since 不合法')
      }
      if (sinceVersion > row.version) {
        // 客户端版本比服务端还新（例如导入覆盖过），让它整份重拉
        reply.code(409)
        return {
          error: { code: 'version_ahead', message: '客户端版本超前，请重新加载会话' },
          current: { id: row.id, version: row.version },
        }
      }
      const delta = chats.delta(userId, row.id, sinceVersion)
      reply.header('cache-control', 'no-store')
      return {
        chat: {
          id: row.id,
          title: row.title,
          updatedAt: row.updated_at,
          version: row.version,
          rootMessageId: row.root_message_id,
          deleted: delta.deleted,
          messages: delta.messages.map((message) => parseMessage(message.data)),
        },
      }
    }
  )

  /**
   * 实时推送（SSE 长连接）：订阅单个会话的增量更新。
   * 建连时可带 ?since=N（或 Last-Event-ID），服务端会立即补发 N 之后的差量，
   * 之后另一台设备每次写入 / 重命名 / 删除都会实时推送 delta / deleted / resync 事件。
   */
  app.get<{ Params: { id: string }; Querystring: { since?: string } }>(
    '/api/chats/:id/events',
    async (request, reply: FastifyReply) => {
      const userId = userIdOf(request)
      const sessionId = request.authSessionId ?? ''
      const chatId = readId(request.params.id, 'invalid_session_id')
      const initialRow = chats.get(userId, chatId)
      if (!initialRow) {
        throw notFound('chat_not_found', '会话不存在')
      }
      const sinceVersion = parseOptionalSince(request.query.since, request.headers['last-event-id'])
      if (!hub.canSubscribe(userId)) {
        throw new HttpError(429, 'too_many_connections', '实时同步连接过多，请关闭多余标签页')
      }

      const clientId = readClientId(request)
      reply.hijack()
      reply.raw.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
        ...corsHeadersFor(request),
      })

      let closed = false
      let lastSentVersion = initialRow.version

      const writeRaw = (chunk: string): boolean => {
        if (closed || reply.raw.writableEnded || reply.raw.destroyed) {
          return false
        }
        try {
          reply.raw.write(chunk)
          return true
        } catch {
          return false
        }
      }

      const sendEvent = (event: string, data: unknown, id?: string): void => {
        const prefix = id !== undefined ? `id: ${id}\n` : ''
        writeRaw(`${prefix}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
      }

      let unsubscribe = () => {}
      let heartbeat: ReturnType<typeof setInterval> | null = null

      const close = (): void => {
        if (closed) {
          return
        }
        closed = true
        if (heartbeat !== null) {
          clearInterval(heartbeat)
          heartbeat = null
        }
        unsubscribe()
        if (!reply.raw.writableEnded && !reply.raw.destroyed) {
          reply.raw.end()
        }
      }

      const pushDeltaFrom = (fromVersion: number): void => {
        if (closed) {
          return
        }
        const current = chats.get(userId, chatId)
        if (!current) {
          sendEvent('deleted', { id: chatId })
          close()
          return
        }
        if (current.version < fromVersion) {
          lastSentVersion = current.version
          sendEvent('resync', { id: current.id, version: current.version, reason: 'version_ahead' })
          return
        }
        if (current.version === fromVersion) {
          lastSentVersion = current.version
          return
        }
        const delta = chats.delta(userId, current.id, fromVersion)
        lastSentVersion = current.version
        sendEvent(
          'delta',
          {
            id: current.id,
            title: current.title,
            updatedAt: current.updated_at,
            version: current.version,
            rootMessageId: current.root_message_id,
            deleted: delta.deleted,
            messages: delta.messages.map((message) => parseMessage(message.data)),
          },
          String(current.version)
        )
      }

      // 先登记订阅，再做初始补发，避免「读快照」与「订阅」之间漏掉并发写入
      unsubscribe = hub.subscribe({
        userId,
        chatId,
        sessionId,
        clientId,
        onDelta: () => {
          pushDeltaFrom(lastSentVersion)
        },
        onDeleted: () => {
          sendEvent('deleted', { id: chatId })
          close()
        },
        onResync: (reason: string) => {
          const current = chats.get(userId, chatId)
          if (!current) {
            sendEvent('deleted', { id: chatId })
            close()
            return
          }
          lastSentVersion = current.version
          sendEvent('resync', { id: current.id, version: current.version, reason })
        },
        close,
      })

      request.raw.on('close', close)
      reply.raw.on('close', close)
      reply.raw.on('error', close)

      // 立刻刷出响应头与就绪帧，让前端与代理尽早确认建连成功
      writeRaw(': connected\n\n')
      sendEvent('ready', { id: initialRow.id, version: initialRow.version })

      if (sinceVersion !== null) {
        if (sinceVersion > initialRow.version) {
          lastSentVersion = initialRow.version
          sendEvent('resync', {
            id: initialRow.id,
            version: initialRow.version,
            reason: 'version_ahead',
          })
        } else if (sinceVersion < initialRow.version) {
          pushDeltaFrom(sinceVersion)
        }
      }

      if (!closed && sseHeartbeatMs > 0) {
        heartbeat = setInterval(() => {
          if (!writeRaw(': ping\n\n')) {
            close()
          }
        }, sseHeartbeatMs)
        heartbeat.unref()
      }
    }
  )

  /** 保存：只提交有变化的消息，服务端在事务里递增版本 */
  app.put<{ Params: { id: string } }>('/api/chats/:id', async (request, reply: FastifyReply) => {
    const userId = userIdOf(request)
    const body = request.body
    if (!isRecord(body)) {
      throw badRequest('invalid_body', '请求体格式不正确')
    }
    const id = readId(request.params.id, 'invalid_session_id')
    const upsert = readMessageChanges(body.upsert, config.chats.maxBytes)
    const deleted = readDeletedList(body.deleted)
    const fileIds = readFileIds(body.fileIds)
    const baseVersion = readBaseVersion(body.baseVersion)

    if (!chats.get(userId, id) && chats.countByUser(userId) >= config.chats.maxPerUser) {
      throw payloadTooLarge(`会话数量已达上限（${config.chats.maxPerUser}）`)
    }

    const result = chats.write(
      userId,
      {
        id,
        title: readTitle(body.title),
        createdAt: readTime(body.createdAt, 'invalid_session_time'),
        updatedAt: readTime(body.updatedAt, 'invalid_session_time'),
        rootMessageId: readRootId(body.rootMessageId),
        upsert,
        deleted,
      },
      baseVersion
    )
    reply.header('cache-control', 'no-store')
    if (!result.ok) {
      // 客户端据此整份重拉、合并后重试
      const current = chats.get(userId, id)
      reply.code(409)
      return {
        error: { code: 'version_conflict', message: '会话已在其他设备上更新' },
        current: current ? { id, version: current.version, updatedAt: current.updated_at } : null,
      }
    }
    // 附件引用按本次提交的完整列表同步，删除会话时据此清理原件
    chats.syncFileRefs(userId, id, fileIds)
    hub.notifyUpdated(userId, id, readClientId(request))
    reply.code(result.created ? 201 : 200)
    return {
      version: result.version,
      updatedAt: result.updatedAt,
      created: result.created,
      messageCount: result.messageCount,
    }
  })

  app.patch<{ Params: { id: string } }>('/api/chats/:id', async (request, reply: FastifyReply) => {
    const userId = userIdOf(request)
    const body = request.body
    if (!isRecord(body)) {
      throw badRequest('invalid_body', '请求体格式不正确')
    }
    const title = readTitle(body.title)
    const at = Date.now()
    const renamed = chats.rename(userId, request.params.id, title, at)
    if (!renamed) {
      throw notFound('chat_not_found', '会话不存在')
    }
    hub.notifyUpdated(userId, request.params.id, readClientId(request))
    reply.header('cache-control', 'no-store')
    return { title, updatedAt: at, version: renamed.version }
  })

  /**
   * 生成（或刷新）分享链接：链接公开可访问，不需要登录，也不需要口令。
   * 快照按当前分支顺序取一次并落库，之后会话再改动不会影响已发出的链接（下次分享时刷新）。
   */
  app.post<{ Params: { id: string } }>(
    '/api/chats/:id/share',
    async (request, reply: FastifyReply) => {
      const userId = userIdOf(request)
      const chatId = readId(request.params.id, 'invalid_session_id')
      const row = chats.get(userId, chatId)
      if (!row) {
        throw notFound('chat_not_found', '会话不存在')
      }
      const all = chats.messages(userId, row.id).map((message) => parseMessage(message.data))
      if (all.length === 0) {
        throw badRequest('empty_chat', '这个对话还没有内容，暂时无法分享')
      }
      // 分享弹窗里可以取消勾选个别消息：传入 messageIds 时只快照这些消息
      const messageIds = readShareMessageIds(
        isRecord(request.body) ? request.body.messageIds : undefined
      )
      const messages = messageIds === null ? all : pickSharedMessages(all, messageIds)
      if (messages.length === 0) {
        throw badRequest('empty_chat', '这个对话还没有内容，暂时无法分享')
      }
      const at = Date.now()
      const session = {
        id: row.id,
        title: row.title,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        // 老数据迁移过来时根消息可能为空：与读取会话时保持一致的兜底
        rootMessageId:
          (messageIds === null
            ? (row.root_message_id ?? (all[0] as { id?: string } | undefined)?.id)
            : (messages[0] as { id?: string } | undefined)?.id) ?? null,
        messages,
      }
      const share = shares.save({
        userId,
        chatId: row.id,
        title: row.title,
        data: JSON.stringify({ session }),
        at,
      })
      reply.header('cache-control', 'no-store')
      return {
        share: {
          token: share.token,
          path: `/s/${share.token}`,
          title: share.title,
          createdAt: share.created_at,
          updatedAt: share.updated_at,
        },
      }
    }
  )

  app.delete<{ Params: { id: string } }>('/api/chats/:id', async (request, reply: FastifyReply) => {
    const userId = userIdOf(request)
    const row = chats.get(userId, request.params.id)
    if (!row) {
      reply.code(204)
      return null
    }
    const fileIds = chats.fileIds(userId, row.id)
    chats.remove(userId, row.id)
    // 分享链接跟着会话一起作废，避免删除后仍能通过旧链接读到内容
    shares.removeByChat(userId, row.id)
    await dropOrphanFiles(userId, fileIds, row.id)
    hub.notifyDeleted(userId, row.id, readClientId(request))
    reply.code(204)
    return null
  })

  /** 整库导入：一个事务里替换该用户的全部会话 */
  app.post(
    '/api/chats/import',
    { bodyLimit: config.chats.maxBytes * 8 },
    async (request, reply: FastifyReply) => {
      const userId = userIdOf(request)
      const body = request.body
      if (!isRecord(body) || !Array.isArray(body.sessions)) {
        throw badRequest('invalid_body', '请求体格式不正确')
      }
      if (body.sessions.length > config.chats.maxPerUser) {
        throw badRequest('too_many_sessions', `一次最多导入 ${config.chats.maxPerUser} 个会话`)
      }
      const sessions = body.sessions.map((item) => {
        if (!isRecord(item)) {
          throw badRequest('invalid_session', '会话数据格式不正确')
        }
        const id = readId(item.id, 'invalid_session_id')
        const messages = readPlainMessages(item.messages, config.chats.maxBytes)
        const fileIds = new Set<string>()
        for (const message of messages) {
          const parsed = JSON.parse(message.data) as { files?: unknown }
          if (!Array.isArray(parsed.files)) {
            continue
          }
          for (const file of parsed.files) {
            if (isRecord(file) && typeof file.id === 'string' && isSafeId(file.id)) {
              fileIds.add(file.id)
            }
          }
        }
        return {
          meta: {
            id,
            title: readTitle(item.title),
            createdAt: readTime(item.createdAt, 'invalid_session_time'),
            updatedAt: readTime(item.updatedAt, 'invalid_session_time'),
            rootMessageId: readRootId(item.rootMessageId),
          },
          messages,
          fileIds: [...fileIds],
        }
      })
      const imported = chats.replaceAll(userId, sessions)
      hub.notifyImported(
        userId,
        new Set(sessions.map((session) => session.meta.id)),
        readClientId(request)
      )
      reply.header('cache-control', 'no-store')
      return { imported }
    }
  )
}
