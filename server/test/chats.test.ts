import assert from 'node:assert/strict'
import test from 'node:test'
import Database from 'better-sqlite3'
import { splitLegacySessions } from '../src/db/schema.js'
import { createTestApp, jsonOf, loginCookie, TEST_USERNAME, userCookie } from './helpers.js'

type Message = { id: string; role: string; createdAt: number; content?: string; files?: unknown[] }

const userMessage = (id: string, content: string): Message => ({
  id,
  role: 'user',
  content,
  files: [],
  createdAt: Math.floor(Math.random() * 1000) + 1,
})

/** 按会话顺序给消息编号，模拟客户端提交的 position */
const changes = (messages: Message[], startAt = 0) =>
  messages.map((message, index) => ({ position: startAt + index, message }))

type App = Awaited<ReturnType<typeof createTestApp>>['app']

/**
 * 登录凭据只有 .env 里那一个账号；多账号隔离用例需要「另一个用户」时直接建库拿会话。
 * 返回值都是 `chat_session=...` 形式的 Cookie。
 */
const register = async (app: App, username: string): Promise<string> =>
  username === TEST_USERNAME ? await loginCookie(app) : userCookie(app, username)

/** 保存一次会话变更：只提交有变化的消息 */
const save = async (
  app: App,
  cookie: string,
  id: string,
  body: {
    baseVersion: number | null
    upsert?: Message[]
    deleted?: string[]
    title?: string
    rootMessageId?: string | null
    /** 起始 position，默认 0 */
    position?: number
  }
) =>
  await app.inject({
    method: 'PUT',
    url: `/api/chats/${id}`,
    headers: { cookie },
    payload: {
      baseVersion: body.baseVersion,
      title: body.title ?? '会话',
      createdAt: 1,
      updatedAt: 100,
      rootMessageId: body.rootMessageId ?? (body.upsert?.[0]?.id ?? null),
      upsert: changes(body.upsert ?? [], body.position ?? 0),
      deleted: body.deleted ?? [],
      fileIds: (body.upsert ?? []).flatMap((message) =>
        (message.files ?? []).map((file) => (file as { id: string }).id)
      ),
    },
  })

test('会话列表只返回元数据，正文按需读取', async (t) => {
  const { app } = await createTestApp()
  t.after(() => app.close())
  const cookie = await register(app, 'ann')

  const created = await save(app, cookie, 'chat-one', {
    baseVersion: null,
    upsert: [userMessage('m1', '你好')],
  })
  assert.equal(created.statusCode, 201)
  assert.equal(jsonOf<{ version: number }>(created.body).version, 1)

  const list = await app.inject({ method: 'GET', url: '/api/chats', headers: { cookie } })
  const chats = jsonOf<{ chats: { id: string; title: string; version: number; messageCount: number }[] }>(
    list.body
  ).chats
  assert.equal(chats.length, 1)
  assert.equal(chats[0]?.messageCount, 1)
  assert.equal('messages' in (chats[0] as object), false, '列表不能带正文')

  const detail = jsonOf<{ chat: { version: number; session: { messages: Message[]; rootMessageId: string } } }>(
    (await app.inject({ method: 'GET', url: '/api/chats/chat-one', headers: { cookie } })).body
  ).chat
  assert.equal(detail.session.messages.length, 1)
  assert.equal(detail.session.messages[0]?.id, 'm1')
  assert.equal(detail.session.rootMessageId, 'm1')
})

test('只提交变化的消息，增量接口只返回变化部分', async (t) => {
  const { app } = await createTestApp()
  t.after(() => app.close())
  const cookie = await register(app, 'ben')

  await save(app, cookie, 'chat-inc', { baseVersion: null, upsert: [userMessage('m1', '第一问')] })
  // 追加一条回复：只传这一条
  const second = await save(app, cookie, 'chat-inc', {
    baseVersion: 1,
    position: 1,
    upsert: [userMessage('m2', '第一答')],
  })
  assert.equal(second.statusCode, 200)
  assert.equal(jsonOf<{ version: number }>(second.body).version, 2)

  // 从版本 1 起拉增量：只有 m2
  const delta = jsonOf<{ chat: { version: number; deleted: string[]; messages: Message[] } }>(
    (
      await app.inject({
        method: 'GET',
        url: '/api/chats/chat-inc/messages?since=1',
        headers: { cookie },
      })
    ).body
  ).chat
  assert.deepEqual(
    delta.messages.map((message) => message.id),
    ['m2']
  )
  assert.deepEqual(delta.deleted, [])
  assert.equal(delta.version, 2)

  // 从最新版本拉：什么都没有
  const empty = jsonOf<{ chat: { messages: Message[]; deleted: string[] } }>(
    (
      await app.inject({
        method: 'GET',
        url: '/api/chats/chat-inc/messages?since=2',
        headers: { cookie },
      })
    ).body
  ).chat
  assert.equal(empty.messages.length, 0)
  assert.equal(empty.deleted.length, 0)

  // 删除一条：增量里出现墓碑
  const removed = await save(app, cookie, 'chat-inc', { baseVersion: 2, deleted: ['m2'] })
  assert.equal(removed.statusCode, 200)
  const afterDelete = jsonOf<{ chat: { deleted: string[]; messages: Message[]; version: number } }>(
    (
      await app.inject({
        method: 'GET',
        url: '/api/chats/chat-inc/messages?since=2',
        headers: { cookie },
      })
    ).body
  ).chat
  assert.deepEqual(afterDelete.deleted, ['m2'])
  assert.equal(afterDelete.version, 3)

  const full = jsonOf<{ chat: { session: { messages: Message[] } } }>(
    (await app.inject({ method: 'GET', url: '/api/chats/chat-inc', headers: { cookie } })).body
  ).chat
  assert.deepEqual(
    full.session.messages.map((message) => message.id),
    ['m1']
  )
})

test('长会话里改一条消息，提交体积与其它消息无关', async (t) => {
  const { app } = await createTestApp()
  t.after(() => app.close())
  const cookie = await register(app, 'bob')

  const many = Array.from({ length: 60 }, (_, index) => userMessage(`m${index}`, `内容 ${index}`))
  const created = await save(app, cookie, 'chat-long', { baseVersion: null, upsert: many })
  assert.equal(created.statusCode, 201)

  const updated = await save(app, cookie, 'chat-long', {
    baseVersion: 1,
    position: 59,
    upsert: [{ ...(many[59] as Message), content: '最后一条改了' }],
  })
  assert.equal(updated.statusCode, 200)
  assert.equal(jsonOf<{ messageCount: number }>(updated.body).messageCount, 60)

  const detail = jsonOf<{ chat: { session: { messages: Message[] } } }>(
    (await app.inject({ method: 'GET', url: '/api/chats/chat-long', headers: { cookie } })).body
  ).chat
  assert.equal(detail.session.messages.length, 60)
  assert.equal((detail.session.messages[59] as Message & { content: string }).content, '最后一条改了')
  assert.equal((detail.session.messages[0] as Message & { content: string }).content, '内容 0')
})

test('版本冲突返回 409，客户端重拉后重试成功', async (t) => {
  const { app } = await createTestApp()
  t.after(() => app.close())
  const cookie = await register(app, 'cara')

  await save(app, cookie, 'chat-conflict', { baseVersion: null, upsert: [userMessage('m1', '初始')] })
  const first = await save(app, cookie, 'chat-conflict', {
    baseVersion: 1,
    position: 1,
    upsert: [userMessage('m2', 'A')],
  })
  assert.equal(first.statusCode, 200)

  const conflict = await save(app, cookie, 'chat-conflict', {
    baseVersion: 1,
    position: 2,
    upsert: [userMessage('m3', 'B')],
  })
  assert.equal(conflict.statusCode, 409)
  const body = jsonOf<{ error: { code: string }; current: { version: number } }>(conflict.body)
  assert.equal(body.error.code, 'version_conflict')
  assert.equal(body.current.version, 2)

  const retry = await save(app, cookie, 'chat-conflict', {
    baseVersion: 2,
    position: 2,
    upsert: [userMessage('m3', 'B')],
  })
  assert.equal(retry.statusCode, 200)
})

test('客户端版本超前时要求整份重拉', async (t) => {
  const { app } = await createTestApp()
  t.after(() => app.close())
  const cookie = await register(app, 'dana')

  await save(app, cookie, 'chat-ahead', { baseVersion: null, upsert: [userMessage('m1', 'x')] })
  const response = await app.inject({
    method: 'GET',
    url: '/api/chats/chat-ahead/messages?since=99',
    headers: { cookie },
  })
  assert.equal(response.statusCode, 409)
  assert.equal(jsonOf<{ error: { code: string } }>(response.body).error.code, 'version_ahead')
})

test('不同用户之间完全隔离', async (t) => {
  const { app } = await createTestApp()
  t.after(() => app.close())
  const alice = await register(app, 'alice_x')
  const bob = await register(app, 'bob_x')

  await save(app, alice, 'private-chat', {
    baseVersion: null,
    upsert: [userMessage('m1', '机密')],
  })

  const bobList = await app.inject({ method: 'GET', url: '/api/chats', headers: { cookie: bob } })
  assert.equal(jsonOf<{ chats: unknown[] }>(bobList.body).chats.length, 0)

  const bobRead = await app.inject({
    method: 'GET',
    url: '/api/chats/private-chat',
    headers: { cookie: bob },
  })
  assert.equal(bobRead.statusCode, 404)

  // 同一个 id 在另一个账号下各写各的，互不影响
  assert.equal(
    (await save(app, bob, 'private-chat', { baseVersion: null, upsert: [userMessage('m1', '覆盖')] }))
      .statusCode,
    201
  )
  const aliceDetail = jsonOf<{ chat: { session: { messages: { content: string }[] } } }>(
    (await app.inject({ method: 'GET', url: '/api/chats/private-chat', headers: { cookie: alice } }))
      .body
  ).chat
  assert.equal(aliceDetail.session.messages[0]?.content, '机密')
})

test('重命名只改标题，不覆盖正文', async (t) => {
  const { app } = await createTestApp()
  t.after(() => app.close())
  const cookie = await register(app, 'eli')

  await save(app, cookie, 'chat-rename', { baseVersion: null, upsert: [userMessage('m1', '正文')] })
  const renamed = await app.inject({
    method: 'PATCH',
    url: '/api/chats/chat-rename',
    headers: { cookie },
    payload: { title: '新标题' },
  })
  assert.equal(renamed.statusCode, 200)

  const detail = jsonOf<{ chat: { title: string; session: { messages: Message[] } } }>(
    (await app.inject({ method: 'GET', url: '/api/chats/chat-rename', headers: { cookie } })).body
  ).chat
  assert.equal(detail.title, '新标题')
  assert.equal(detail.session.messages.length, 1)
})

test('删除会话后列表与正文都消失', async (t) => {
  const { app } = await createTestApp()
  t.after(() => app.close())
  const cookie = await register(app, 'finn')

  await save(app, cookie, 'chat-del', { baseVersion: null, upsert: [userMessage('m1', '删掉我')] })
  assert.equal(
    (await app.inject({ method: 'DELETE', url: '/api/chats/chat-del', headers: { cookie } })).statusCode,
    204
  )
  const list = await app.inject({ method: 'GET', url: '/api/chats', headers: { cookie } })
  assert.equal(jsonOf<{ chats: unknown[] }>(list.body).chats.length, 0)
})

test('导入是用归档整体替换', async (t) => {
  const { app } = await createTestApp()
  t.after(() => app.close())
  const cookie = await register(app, 'gia')

  await save(app, cookie, 'old-chat', { baseVersion: null, upsert: [userMessage('m1', '旧数据')] })

  const imported = await app.inject({
    method: 'POST',
    url: '/api/chats/import',
    headers: { cookie },
    payload: {
      sessions: [
        { id: 'new-1', title: '一', createdAt: 1, updatedAt: 2, rootMessageId: 'a', messages: [userMessage('a', '导入一')] },
        { id: 'new-2', title: '二', createdAt: 1, updatedAt: 3, rootMessageId: 'b', messages: [userMessage('b', '导入二')] },
      ],
    },
  })
  assert.equal(imported.statusCode, 200)
  assert.equal(jsonOf<{ imported: number }>(imported.body).imported, 2)

  const chats = jsonOf<{ chats: { id: string; messageCount: number }[] }>(
    (await app.inject({ method: 'GET', url: '/api/chats', headers: { cookie } })).body
  ).chats
  assert.deepEqual(chats.map((chat) => chat.id).sort(), ['new-1', 'new-2'])
  assert.equal(chats.every((chat) => chat.messageCount === 1), true)
})

test('单次提交过大被拒绝', async (t) => {
  const { app } = await createTestApp({ CHAT_MAX_MB: '1' })
  t.after(() => app.close())
  const cookie = await register(app, 'hana')

  const huge = userMessage('m1', 'x'.repeat(1_500_000))
  const response = await save(app, cookie, 'chat-huge', { baseVersion: null, upsert: [huge] })
  assert.equal(response.statusCode, 413)
})

test('附件原件可以往返存取，被会话引用时不能单独删除', async (t) => {
  const { app } = await createTestApp()
  t.after(() => app.close())
  const cookie = await register(app, 'iris')

  const upload = await app.inject({
    method: 'PUT',
    url: '/api/files/file-1',
    headers: { cookie, 'content-type': 'image/png' },
    payload: Buffer.from('fake-png-bytes'),
  })
  assert.equal(upload.statusCode, 201)

  const download = await app.inject({ method: 'GET', url: '/api/files/file-1', headers: { cookie } })
  assert.equal(download.statusCode, 200)
  assert.equal(download.rawPayload.toString(), 'fake-png-bytes')

  const other = await register(app, 'iris2')
  assert.equal(
    (await app.inject({ method: 'GET', url: '/api/files/file-1', headers: { cookie: other } })).statusCode,
    404
  )

  const withFile: Message & { files: unknown[] } = {
    ...userMessage('m1', '带附件'),
    files: [{ id: 'file-1', serverId: null, name: 'a.png', size: 14, isImage: true, mimeType: 'image/png' }],
  }
  await save(app, cookie, 'chat-with-file', { baseVersion: null, upsert: [withFile] })

  assert.equal(
    (await app.inject({ method: 'DELETE', url: '/api/files/file-1', headers: { cookie } })).statusCode,
    409
  )
  await app.inject({ method: 'DELETE', url: '/api/chats/chat-with-file', headers: { cookie } })
  assert.equal(
    (await app.inject({ method: 'GET', url: '/api/files/file-1', headers: { cookie } })).statusCode,
    404
  )
})

test('未登录不能访问会话与附件接口', async (t) => {
  const { app } = await createTestApp()
  t.after(() => app.close())

  for (const [method, url] of [
    ['GET', '/api/chats'],
    ['GET', '/api/chats/x'],
    ['GET', '/api/chats/x/messages?since=0'],
    ['GET', '/api/chats/x/events'],
    ['PUT', '/api/chats/x'],
    ['DELETE', '/api/chats/x'],
    ['POST', '/api/chats/import'],
    ['GET', '/api/files/x'],
    ['PUT', '/api/files/x'],
  ] as const) {
    const response = await app.inject({ method, url, payload: {} })
    assert.equal(response.statusCode, 401, `${method} ${url} 应该要求登录`)
  }
})

test('旧版本的整体 JSON 会迁移成消息行', () => {
  const db = new Database(':memory:')
  // v2 的 chats 结构（data 存整份会话 JSON）
  db.exec(`
    CREATE TABLE chats (
      id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      title TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      version INTEGER NOT NULL,
      message_count INTEGER NOT NULL DEFAULT 0,
      data TEXT NOT NULL,
      PRIMARY KEY (user_id, id)
    );
    CREATE TABLE chat_messages (
      user_id TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      position INTEGER NOT NULL,
      role TEXT NOT NULL,
      data TEXT NOT NULL,
      PRIMARY KEY (user_id, chat_id, id)
    );
  `)
  db.exec('ALTER TABLE chats ADD COLUMN root_message_id TEXT')
  db.prepare('INSERT INTO chats (id, user_id, title, created_at, updated_at, version, message_count, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
    'old-chat',
    'user-1',
    '老会话',
    1,
    2,
    5,
    3,
    JSON.stringify({
      id: 'old-chat',
      title: '老会话',
      rootMessageId: 'a',
      messages: [
        { id: 'a', role: 'user', content: '一' },
        { id: 'b', role: 'assistant', blocks: [] },
        { id: 'c', role: 'user', content: '二' },
      ],
    })
  )
  splitLegacySessions(db)
  const rows = db
    .prepare('SELECT id, position, role, revision FROM chat_messages WHERE chat_id = ? ORDER BY position')
    .all('old-chat') as { id: string; position: number; role: string; revision: number }[]
  assert.deepEqual(
    rows.map((row) => [row.id, row.position, row.role]),
    [
      ['a', 0, 'user'],
      ['b', 1, 'assistant'],
      ['c', 2, 'user'],
    ]
  )
  assert.equal(rows.every((row) => row.revision === 1), true)
  const root = db.prepare('SELECT root_message_id FROM chats WHERE id = ?').get('old-chat') as {
    root_message_id: string | null
  }
  assert.equal(root.root_message_id, 'a', '迁移后要保留根消息，否则会话会被当成空会话')
  db.close()
})
