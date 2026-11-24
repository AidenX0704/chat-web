import assert from 'node:assert/strict'
import test from 'node:test'
import { createTestApp, jsonOf, loginCookie, userCookie } from './helpers.js'

type Message = { id: string; role: string; createdAt: number; content?: string; files?: unknown[] }

const message = (id: string, role: 'user' | 'assistant', content: string): Message => ({
  id,
  role,
  createdAt: 1,
  content,
  files: [],
})

type App = Awaited<ReturnType<typeof createTestApp>>['app']

/** 保存一个完整会话（单分支线性消息），便于分享用例直接取用 */
const saveSession = async (app: App, cookie: string, id: string, messages: Message[]) =>
  await app.inject({
    method: 'PUT',
    url: `/api/chats/${id}`,
    headers: { cookie },
    payload: {
      baseVersion: null,
      title: '要分享的会话',
      createdAt: 1,
      updatedAt: 100,
      rootMessageId: messages[0]?.id ?? null,
      upsert: messages.map((item, index) => ({ position: index, message: item })),
      deleted: [],
      fileIds: [],
    },
  })

const createShare = async (app: App, cookie: string, id: string) =>
  await app.inject({ method: 'POST', url: `/api/chats/${id}/share`, headers: { cookie } })

test('分享链接不需要登录即可读取会话内容', async (t) => {
  const { app } = await createTestApp()
  t.after(() => app.close())
  const cookie = await loginCookie(app)
  await saveSession(app, cookie, 'shared-chat', [
    message('m1', 'user', '你好'),
    message('m2', 'assistant', '你好，有什么可以帮你？'),
  ])

  const created = await createShare(app, cookie, 'shared-chat')
  assert.equal(created.statusCode, 200)
  const { share } = jsonOf<{ share: { token: string; path: string } }>(created.body)
  assert.match(share.token, /^[A-Za-z0-9_-]{16,64}$/)
  assert.equal(share.path, `/s/${share.token}`)

  // 关键点：不带 Cookie、不带任何凭据
  const publicRead = await app.inject({ method: 'GET', url: `/api/shares/${share.token}` })
  assert.equal(publicRead.statusCode, 200)
  assert.equal(publicRead.headers['cache-control'], 'no-store')
  const body = jsonOf<{ share: { title: string; session: { messages: Message[] } } }>(
    publicRead.body
  )
  assert.equal(body.share.title, '要分享的会话')
  assert.deepEqual(
    body.share.session.messages.map((item) => item.id),
    ['m1', 'm2']
  )
  assert.equal(body.share.session.messages[1]?.content, '你好，有什么可以帮你？')
})

test('重复分享沿用同一个令牌，并刷新成最新内容', async (t) => {
  const { app } = await createTestApp()
  t.after(() => app.close())
  const cookie = await loginCookie(app)
  await saveSession(app, cookie, 'chat-refresh', [message('m1', 'user', '第一版')])
  const first = await createShare(app, cookie, 'chat-refresh')
  const firstToken = jsonOf<{ share: { token: string } }>(first.body).share.token

  await saveSession(app, cookie, 'chat-refresh', [
    message('m1', 'user', '第一版'),
    message('m2', 'assistant', '第二版'),
  ])
  const second = await createShare(app, cookie, 'chat-refresh')
  const secondToken = jsonOf<{ share: { token: string } }>(second.body).share.token
  assert.equal(secondToken, firstToken)

  const publicRead = await app.inject({ method: 'GET', url: `/api/shares/${firstToken}` })
  const body = jsonOf<{ share: { session: { messages: Message[] } } }>(publicRead.body)
  assert.equal(body.share.session.messages.length, 2)
})

test('令牌不存在或形状不对都返回 404', async (t) => {
  const { app } = await createTestApp()
  t.after(() => app.close())
  const missing = await app.inject({
    method: 'GET',
    url: '/api/shares/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  })
  assert.equal(missing.statusCode, 404)
  assert.equal(jsonOf<{ error: { code: string } }>(missing.body).error.code, 'share_not_found')

  const malformed = await app.inject({ method: 'GET', url: '/api/shares/..%2Fetc' })
  assert.equal(malformed.statusCode, 404)
})

test('删除会话后旧分享链接失效', async (t) => {
  const { app } = await createTestApp()
  t.after(() => app.close())
  const cookie = await loginCookie(app)
  await saveSession(app, cookie, 'chat-doomed', [message('m1', 'user', '待删除')])
  const created = await createShare(app, cookie, 'chat-doomed')
  const token = jsonOf<{ share: { token: string } }>(created.body).share.token

  const removed = await app.inject({
    method: 'DELETE',
    url: '/api/chats/chat-doomed',
    headers: { cookie },
  })
  assert.equal(removed.statusCode, 204)

  const publicRead = await app.inject({ method: 'GET', url: `/api/shares/${token}` })
  assert.equal(publicRead.statusCode, 404)
})

test('不能分享别人的会话', async (t) => {
  const { app } = await createTestApp()
  t.after(() => app.close())
  const ann = await loginCookie(app)
  await saveSession(app, ann, 'ann-chat', [message('m1', 'user', '我的会话')])

  const bob = userCookie(app, 'bob')
  const denied = await createShare(app, bob, 'ann-chat')
  assert.equal(denied.statusCode, 404)
})

test('生成分享链接需要登录', async (t) => {
  const { app } = await createTestApp()
  t.after(() => app.close())
  const anonymous = await app.inject({ method: 'POST', url: '/api/chats/x/share' })
  assert.equal(anonymous.statusCode, 401)
})

test('空会话不能分享', async (t) => {
  const { app } = await createTestApp()
  t.after(() => app.close())
  const cookie = await loginCookie(app)
  await saveSession(app, cookie, 'empty-chat', [])
  const created = await createShare(app, cookie, 'empty-chat')
  assert.equal(created.statusCode, 400)
  assert.equal(jsonOf<{ error: { code: string } }>(created.body).error.code, 'empty_chat')
})

type SharedSessionBody = {
  share: {
    session: {
      rootMessageId: string
      messages: (Message & { parentId?: string | null; selectedChildId?: string })[]
    }
  }
}

test('可以只分享选中的消息，剩下的重排成单分支', async (t) => {
  const { app } = await createTestApp()
  t.after(() => app.close())
  const cookie = await loginCookie(app)
  await saveSession(app, cookie, 'pick-chat', [
    message('m1', 'user', '第一句'),
    message('m2', 'assistant', '第二句'),
    message('m3', 'user', '第三句'),
  ])

  const created = await app.inject({
    method: 'POST',
    url: '/api/chats/pick-chat/share',
    headers: { cookie },
    payload: { messageIds: ['m1', 'm3'] },
  })
  assert.equal(created.statusCode, 200)
  const token = jsonOf<{ share: { token: string } }>(created.body).share.token

  const publicRead = await app.inject({ method: 'GET', url: '/api/shares/' + token })
  const body = jsonOf<SharedSessionBody>(publicRead.body)
  assert.deepEqual(
    body.share.session.messages.map((item) => item.id),
    ['m1', 'm3']
  )
  // 被排除的消息不留下断口：选中的消息首尾相接
  assert.equal(body.share.session.rootMessageId, 'm1')
  assert.equal(body.share.session.messages[0]?.parentId, null)
  assert.equal(body.share.session.messages[0]?.selectedChildId, 'm3')
  assert.equal(body.share.session.messages[1]?.parentId, 'm1')
  assert.equal(body.share.session.messages[1]?.selectedChildId, undefined)
})

test('一条都没选时不能分享', async (t) => {
  const { app } = await createTestApp()
  t.after(() => app.close())
  const cookie = await loginCookie(app)
  await saveSession(app, cookie, 'none-picked', [message('m1', 'user', '你好')])

  const created = await app.inject({
    method: 'POST',
    url: '/api/chats/none-picked/share',
    headers: { cookie },
    payload: { messageIds: [] },
  })
  assert.equal(created.statusCode, 400)
  assert.equal(jsonOf<{ error: { code: string } }>(created.body).error.code, 'empty_chat')
})

test('可以列出并撤销自己的分享链接', async (t) => {
  const { app } = await createTestApp()
  t.after(() => app.close())
  const cookie = await loginCookie(app)
  await saveSession(app, cookie, 'managed-chat', [message('m1', 'user', '要分享的内容')])
  const created = await app.inject({
    method: 'POST',
    url: '/api/chats/managed-chat/share',
    headers: { cookie },
  })
  const token = jsonOf<{ share: { token: string } }>(created.body).share.token

  const list = await app.inject({ method: 'GET', url: '/api/shares', headers: { cookie } })
  assert.equal(list.statusCode, 200)
  const body = jsonOf<{ shares: { token: string; path: string; title: string }[] }>(list.body)
  assert.equal(body.shares.length, 1)
  assert.equal(body.shares[0]?.token, token)
  assert.equal(body.shares[0]?.path, '/s/' + token)
  assert.equal(body.shares[0]?.title, '要分享的会话')

  // 列表需要登录
  const anonymous = await app.inject({ method: 'GET', url: '/api/shares' })
  assert.equal(anonymous.statusCode, 401)

  const removed = await app.inject({
    method: 'DELETE',
    url: '/api/shares/' + token,
    headers: { cookie },
  })
  assert.equal(removed.statusCode, 204)
  const publicRead = await app.inject({ method: 'GET', url: '/api/shares/' + token })
  assert.equal(publicRead.statusCode, 404)

  const afterRemoval = await app.inject({ method: 'GET', url: '/api/shares', headers: { cookie } })
  assert.deepEqual(jsonOf<{ shares: unknown[] }>(afterRemoval.body).shares, [])
})
