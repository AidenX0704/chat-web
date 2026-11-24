/**
 * 会话实时推送中心（内存事件总线）：
 *
 * 单进程部署下，一个会话被写入、重命名、删除或整库导入后，
 * 立刻通知该账号下正在订阅此会话的其他设备（SSE 长连接）。
 *
 * 订阅方自己维护 `lastSentVersion`，收到通知后按现有的 `chats.delta(since)`
 * 拉出差量帧推送给浏览器，不重复造一套同步协议。
 */

export type ChatSubscriber = {
  userId: string
  chatId: string
  sessionId: string
  clientId: string | null
  onDelta: () => void
  onDeleted: () => void
  onResync: (reason: string) => void
  close: () => void
}

export type ChatEventHubOptions = {
  /** 单个账号最多同时保持多少条 SSE 订阅连接 */
  maxConnectionsPerUser?: number
}

export type ChatEventHub = ReturnType<typeof createChatEventHub>

const DEFAULT_MAX_CONNECTIONS_PER_USER = 32

export const createChatEventHub = (options: ChatEventHubOptions = {}) => {
  const maxConnectionsPerUser = options.maxConnectionsPerUser ?? DEFAULT_MAX_CONNECTIONS_PER_USER

  /** userId -> chatId -> Set<ChatSubscriber> */
  const byChat = new Map<string, Map<string, Set<ChatSubscriber>>>()
  /** userId -> Set<ChatSubscriber>（用于限制单账号连接数、整库导入与踢设备） */
  const byUser = new Map<string, Set<ChatSubscriber>>()

  const unsubscribe = (subscriber: ChatSubscriber): void => {
    const userSubs = byUser.get(subscriber.userId)
    if (userSubs) {
      userSubs.delete(subscriber)
      if (userSubs.size === 0) {
        byUser.delete(subscriber.userId)
      }
    }
    const userChats = byChat.get(subscriber.userId)
    const chatSubs = userChats?.get(subscriber.chatId)
    if (chatSubs) {
      chatSubs.delete(subscriber)
      if (chatSubs.size === 0) {
        userChats?.delete(subscriber.chatId)
      }
    }
    if (userChats && userChats.size === 0) {
      byChat.delete(subscriber.userId)
    }
  }

  const shouldDeliver = (subscriber: ChatSubscriber, originClientId: string | null): boolean =>
    originClientId === null || subscriber.clientId === null || subscriber.clientId !== originClientId

  return {
    canSubscribe(userId: string): boolean {
      return (byUser.get(userId)?.size ?? 0) < maxConnectionsPerUser
    },

    subscribe(subscriber: ChatSubscriber): () => void {
      let userSubs = byUser.get(subscriber.userId)
      if (!userSubs) {
        userSubs = new Set()
        byUser.set(subscriber.userId, userSubs)
      }
      userSubs.add(subscriber)

      let userChats = byChat.get(subscriber.userId)
      if (!userChats) {
        userChats = new Map()
        byChat.set(subscriber.userId, userChats)
      }
      let chatSubs = userChats.get(subscriber.chatId)
      if (!chatSubs) {
        chatSubs = new Set()
        userChats.set(subscriber.chatId, chatSubs)
      }
      chatSubs.add(subscriber)

      let active = true
      return () => {
        if (!active) {
          return
        }
        active = false
        unsubscribe(subscriber)
      }
    },

    /** 会话正文或标题更新：通知同账号下其他订阅此会话的设备推送增量 */
    notifyUpdated(userId: string, chatId: string, originClientId: string | null = null): void {
      const chatSubs = byChat.get(userId)?.get(chatId)
      if (!chatSubs) {
        return
      }
      for (const subscriber of [...chatSubs]) {
        if (shouldDeliver(subscriber, originClientId)) {
          subscriber.onDelta()
        }
      }
    },

    /** 会话被删除：通知正在查看它的设备退出并清理本地缓存 */
    notifyDeleted(userId: string, chatId: string, originClientId: string | null = null): void {
      const chatSubs = byChat.get(userId)?.get(chatId)
      if (!chatSubs) {
        return
      }
      for (const subscriber of [...chatSubs]) {
        if (shouldDeliver(subscriber, originClientId)) {
          subscriber.onDeleted()
        }
      }
    },

    /** 整库导入替换了该用户的全部会话：仍在列表里的要求整份重拉，消失的按删除处理 */
    notifyImported(
      userId: string,
      existingChatIds: Set<string>,
      originClientId: string | null = null
    ): void {
      const userSubs = byUser.get(userId)
      if (!userSubs) {
        return
      }
      for (const subscriber of [...userSubs]) {
        if (!shouldDeliver(subscriber, originClientId)) {
          continue
        }
        if (existingChatIds.has(subscriber.chatId)) {
          subscriber.onResync('imported')
        } else {
          subscriber.onDeleted()
        }
      }
    },

    /** 登出或被踢掉的设备：立即断开它占用的 SSE 长连接 */
    disconnectSession(sessionId: string): void {
      for (const userSubs of [...byUser.values()]) {
        for (const subscriber of [...userSubs]) {
          if (subscriber.sessionId === sessionId) {
            subscriber.close()
          }
        }
      }
    },

    /** 修改密码或踢掉其余设备：断开除当前设备外的所有长连接 */
    disconnectOtherSessions(userId: string, keepSessionId: string): void {
      const userSubs = byUser.get(userId)
      if (!userSubs) {
        return
      }
      for (const subscriber of [...userSubs]) {
        if (subscriber.sessionId !== keepSessionId) {
          subscriber.close()
        }
      }
    },

    /** 服务关闭时主动结束所有长连接，避免进程退出挂起 */
    closeAll(): void {
      for (const userSubs of [...byUser.values()]) {
        for (const subscriber of [...userSubs]) {
          subscriber.close()
        }
      }
      byChat.clear()
      byUser.clear()
    },

    count(userId?: string): number {
      if (userId !== undefined) {
        return byUser.get(userId)?.size ?? 0
      }
      let total = 0
      for (const userSubs of byUser.values()) {
        total += userSubs.size
      }
      return total
    },
  }
}
