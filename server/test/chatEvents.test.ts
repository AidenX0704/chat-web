import assert from 'node:assert/strict'
import test from 'node:test'
import { createChatEventHub } from '../src/lib/chatEvents.js'
import { createTestApp, jsonOf, loginCookie, userCookie } from './helpers.js'

type SseFrame = {
  id: string
  event: string
  data: unknown
}

/** 轻量 SSE 读取器：按空行切分帧并解析 JSON，便于逐帧断言实时推送 */
const openSse = async (
  url: string,
  headers: Record<string, string>
): Promise<{
  status: number
  headers: Headers
  nextEvent: (timeoutMs?: number) => Promise<SseFrame>
  waitClosed: (timeoutMs?: number) => Promise<void>
  close: () => void
}> => {
  const controller = new AbortController()
  const response = await fetch(url, { headers, signal: controller.signal })
  assert.ok(response.body, 'SSE 响应体不应为空')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const queue: SseFrame[] = []
  let closed = false
  const waiters: ((frame: SseFrame | null) => void)[] = []
  const closeWaiters: (() => void)[] = []

  const flushWaiters = () => {
    while (queue.length > 0 && waiters.length > 0) {
      const waiter = waiters.shift()
      const frame = queue.shift()
      if (waiter && frame) {
        waiter(frame)
      }
    }
  }

  const pushText = (chunk: string) => {
    buffer += chunk
    for (;;) {
      const idx = buffer.indexOf('\n\n')
      if (idx === -1) {
        break
      }
      const raw = buffer.slice(0, idx)
      buffer = buffer.slice(idx + 2)
      const lines = raw.split(/\r?\n/)
      let event = 'message'
      let id = ''
      const dataLines: string[] = []
      for (const line of lines) {
        if (line === '' || line.startsWith(':')) {
          continue
        }
        const colon = line.indexOf(':')
        const field = colon === -1 ? line : line.slice(0, colon)
        const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '')
        if (field === 'event') {
          event = value
        } else if (field === 'id') {
          id = value
        } else if (field === 'data') {
          dataLines.push(value)
        }
      }
      if (dataLines.length > 0) {
        queue.push({ id, event, data: JSON.parse(dataLines.join('\n')) as unknown })
      }
    }
    flushWaiters()
  }

  void (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) {
          break
        }
        pushText(decoder.decode(value, { stream: true }))
      }
    } catch {
      // 主动 abort 关闭连接
    } finally {
      closed = true
      while (waiters.length > 0) {
        waiters.shift()?.(null)
      }
      while (closeWaiters.length > 0) {
        closeWaiters.shift()?.()
      }
    }
  })()

  const nextEvent = (timeoutMs = 3000): Promise<SseFrame> => {
    if (queue.length > 0) {
      return Promise.resolve(queue.shift() as SseFrame)
    }
    if (closed) {
      return Promise.reject(new Error('SSE stream already closed'))
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('等待 SSE 事件超时')), timeoutMs)
      waiters.push((frame) => {
        clearTimeout(timer)
        if (frame === null) {
          reject(new Error('SSE 流在收到下一帧前关闭'))
          return
        }
        resolve(frame)
      })
    })
  }

  const waitClosed = (timeoutMs = 3000): Promise<void> => {
    if (closed) {
      return Promise.resolve()
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('等待 SSE 关闭超时')), timeoutMs)
      closeWaiters.push(() => {
        clearTimeout(timer)
        resolve()
      })
    })
  }

  return {
    status: response.status,
    headers: response.headers,
    nextEvent,
    waitClosed,
    close: () => controller.abort(),
  }
}

test('ChatEventHub 正确分发事件、抑制同端回声并在踢设备时断开连接', () => {
  const hub = createChatEventHub({ maxConnectionsPerUser: 2 })
  const log: string[] = []

  const unsubA = hub.subscribe({
    userId: 'u1',
    chatId: 'c1',
    sessionId: 's1',
    clientId: 'tab-a',
    onDelta: () => log.push('a:delta'),
    onDeleted: () => log.push('a:deleted'),
    onResync: (reason) => log.push(`a:resync:${reason}`),
    close: () => {
      log.push('a:close')
      unsubA()
    },
  })
  const unsubB = hub.subscribe({
    userId: 'u1',
    chatId: 'c1',
    sessionId: 's2',
    clientId: 'tab-b',
    onDelta: () => log.push('b:delta'),
    onDeleted: () => log.push('b:deleted'),
    onResync: (reason) => log.push(`b:resync:${reason}`),
    close: () => {
      log.push('b:close')
      unsubB()
    },
  })

  assert.equal(hub.canSubscribe('u1'), false)
  // tab-a 触发更新：只推送给 tab-b，不回声给 tab-a
  hub.notifyUpdated('u1', 'c1', 'tab-a')
  assert.deepEqual(log, ['b:delta'])

  // 整库导入：c1 仍在列表里 -> 推送 resync
  hub.notifyImported('u1', new Set(['c1']), 'tab-a')
  assert.deepEqual(log, ['b:delta', 'b:resync:imported'])

  // 踢掉其他设备（保留 s1）：s2 立刻断开
  hub.disconnectOtherSessions('u1', 's1')
  assert.deepEqual(log, ['b:delta', 'b:resync:imported', 'b:close'])
  assert.equal(hub.count('u1'), 1)
  assert.equal(hub.canSubscribe('u1'), true)

  hub.closeAll()
  assert.equal(hub.count(), 0)
})

test('SSE 参数校验与越权隔离（不存在的会话返回 404，非法 since 返回 400）', async (t) => {
  const { app } = await createTestApp()
  t.after(() => app.close())

  // A 是 .env 里的个人账号；B 直接建库模拟另一个用户，用来验证跨用户隔离
  const cookieA = await loginCookie(app)
  const cookieB = userCookie(app, 'sse_bob')

  await app.inject({
    method: 'PUT',
    url: '/api/chats/chat-a',
    headers: { cookie: cookieA },
    payload: {
      baseVersion: null,
      title: 'A 的会话',
      createdAt: 1,
      updatedAt: 1,
      rootMessageId: 'm1',
      upsert: [{ position: 0, message: { id: 'm1', role: 'user', content: 'hi', files: [], createdAt: 1 } }],
      deleted: [],
      fileIds: [],
    },
  })

  // Bob 订阅 Alice 的会话 -> 404
  const forbiddenRead = await app.inject({
    method: 'GET',
    url: '/api/chats/chat-a/events?since=0',
    headers: { cookie: cookieB },
  })
  assert.equal(forbiddenRead.statusCode, 404)

  // 非法 since -> 400
  const invalidSince = await app.inject({
    method: 'GET',
    url: '/api/chats/chat-a/events?since=-1',
    headers: { cookie: cookieA },
  })
  assert.equal(invalidSince.statusCode, 400)
})

test('GET /api/chats/:id/events 实时推送流式生成增量、重命名与删除，并配合 since 补发', async (t) => {
  const { app } = await createTestApp()
  const address = await app.listen({ host: '127.0.0.1', port: 0 })
  t.after(() => app.close())

  // 同一账号登录两台设备，用来验证多端实时同步
  const deviceACookie = await loginCookie(app, { userAgent: 'device-a' })
  const deviceBCookie = await loginCookie(app, { userAgent: 'device-b' })

  // 初始写入版本 1（用户提问）与版本 2（首段回复）
  const put = (
    cookie: string,
    clientId: string,
    baseVersion: number | null,
    upsert: { position: number; message: Record<string, unknown> }[],
    updatedAt: number
  ) =>
    app.inject({
      method: 'PUT',
      url: '/api/chats/chat-live',
      headers: { cookie, 'x-client-id': clientId },
      payload: {
        baseVersion,
        title: '实时会话',
        createdAt: 100,
        updatedAt,
        rootMessageId: 'u1',
        upsert,
        deleted: [],
        fileIds: [],
      },
    })

  assert.equal(
    (
      await put(
        deviceACookie,
        'device-a',
        null,
        [{ position: 0, message: { id: 'u1', role: 'user', content: '讲个故事', files: [], createdAt: 100 } }],
        100
      )
    ).statusCode,
    201
  )
  assert.equal(
    (
      await put(
        deviceACookie,
        'device-a',
        1,
        [
          {
            position: 1,
            message: {
              id: 'a1',
              role: 'assistant',
              status: 'streaming',
              blocks: [{ type: 'text', text: '从前有座山' }],
              createdAt: 101,
            },
          },
        ],
        101
      )
    ).statusCode,
    200
  )

  // 设备 B 带着 since=1 建连：应立刻收到 ready(v2) 与补发 delta(v2, 包含 a1)
  const streamB = await openSse(`${address}/api/chats/chat-live/events?since=1`, {
    cookie: deviceBCookie,
    'x-client-id': 'device-b',
  })
  t.after(() => streamB.close())
  assert.equal(streamB.status, 200)
  assert.match(streamB.headers.get('content-type') ?? '', /text\/event-stream/)

  const ready = await streamB.nextEvent()
  assert.equal(ready.event, 'ready')
  assert.deepEqual(ready.data, { id: 'chat-live', version: 2 })

  const catchUp = await streamB.nextEvent()
  assert.equal(catchUp.event, 'delta')
  assert.equal(catchUp.id, '2')
  const catchUpData = catchUp.data as { version: number; messages: { id: string; blocks: { text: string }[] }[] }
  assert.equal(catchUpData.version, 2)
  assert.equal(catchUpData.messages.length, 1)
  assert.equal(catchUpData.messages[0]?.blocks[0]?.text, '从前有座山')

  // 设备 A 也订阅同一个会话，验证自己写的不回声给自己
  const streamA = await openSse(`${address}/api/chats/chat-live/events?since=2`, {
    cookie: deviceACookie,
    'x-client-id': 'device-a',
  })
  t.after(() => streamA.close())
  assert.equal((await streamA.nextEvent()).event, 'ready')

  // 设备 A 继续流式写入（版本 3 -> streaming，版本 4 -> done）
  assert.equal(
    (
      await put(
        deviceACookie,
        'device-a',
        2,
        [
          {
            position: 1,
            message: {
              id: 'a1',
              role: 'assistant',
              status: 'streaming',
              blocks: [{ type: 'text', text: '从前有座山，山里有座庙' }],
              createdAt: 101,
            },
          },
        ],
        102
      )
    ).statusCode,
    200
  )

  const chunk3 = await streamB.nextEvent()
  assert.equal(chunk3.event, 'delta')
  assert.equal(chunk3.id, '3')
  const chunk3Data = chunk3.data as {
    version: number
    messages: { id: string; status: string; blocks: { text: string }[] }[]
  }
  assert.equal(chunk3Data.version, 3)
  assert.equal(chunk3Data.messages[0]?.status, 'streaming')
  assert.equal(chunk3Data.messages[0]?.blocks[0]?.text, '从前有座山，山里有座庙')

  assert.equal(
    (
      await put(
        deviceACookie,
        'device-a',
        3,
        [
          {
            position: 1,
            message: {
              id: 'a1',
              role: 'assistant',
              status: 'done',
              blocks: [{ type: 'text', text: '从前有座山，山里有座庙。讲完了。' }],
              createdAt: 101,
            },
          },
        ],
        103
      )
    ).statusCode,
    200
  )

  const chunk4 = await streamB.nextEvent()
  assert.equal(chunk4.event, 'delta')
  assert.equal(chunk4.id, '4')
  const chunk4Data = chunk4.data as {
    version: number
    messages: { id: string; status: string; blocks: { text: string }[] }[]
  }
  assert.equal(chunk4Data.messages[0]?.status, 'done')

  // 重命名：设备 B 收到 delta（标题更新，version 5）
  const renameRes = await app.inject({
    method: 'PATCH',
    url: '/api/chats/chat-live',
    headers: { cookie: deviceACookie, 'x-client-id': 'device-a' },
    payload: { title: '山与庙' },
  })
  assert.equal(renameRes.statusCode, 200)
  assert.equal(jsonOf<{ version: number }>(renameRes.body).version, 5)

  const renamed = await streamB.nextEvent()
  assert.equal(renamed.event, 'delta')
  assert.equal((renamed.data as { title: string; version: number }).title, '山与庙')
  assert.equal((renamed.data as { version: number }).version, 5)

  // 版本超前建连 -> 推送 resync
  const aheadStream = await openSse(`${address}/api/chats/chat-live/events?since=99`, {
    cookie: deviceBCookie,
  })
  t.after(() => aheadStream.close())
  assert.equal((await aheadStream.nextEvent()).event, 'ready')
  const resync = await aheadStream.nextEvent()
  assert.equal(resync.event, 'resync')
  assert.deepEqual(resync.data, { id: 'chat-live', version: 5, reason: 'version_ahead' })

  // 设备 A 删除会话 -> 设备 B 收到 deleted 并断开
  assert.equal(
    (
      await app.inject({
        method: 'DELETE',
        url: '/api/chats/chat-live',
        headers: { cookie: deviceACookie, 'x-client-id': 'device-a' },
      })
    ).statusCode,
    204
  )
  const deleted = await streamB.nextEvent()
  assert.equal(deleted.event, 'deleted')
  assert.deepEqual(deleted.data, { id: 'chat-live' })
  await streamB.waitClosed()
})
