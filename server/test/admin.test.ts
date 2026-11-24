import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import test from 'node:test'
import { createTestApp, jsonOf, loginCookie } from './helpers.js'

const startCapturingUpstream = async (): Promise<{
  origin: string
  server: Server
  received: Record<string, unknown>[]
}> => {
  const received: Record<string, unknown>[] = []
  const server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      if (raw) {
        try {
          received.push(JSON.parse(raw) as Record<string, unknown>)
        } catch {
          // non-json
        }
      }
      if (request.url?.startsWith('/anthropic/v1/messages')) {
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        response.write(
          'event: message_start\ndata: {"type":"message_start","message":{"id":"m1","model":"deepseek-flash","usage":{"input_tokens":42,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"output_tokens":0}}}\n\n'
        )
        response.write(
          'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"先想一下"}}\n\n'
        )
        response.write(
          'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"你好，这是测试回答。"}}\n\n'
        )
        response.write(
          'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"input_tokens":42,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"output_tokens":18}}\n\n'
        )
        response.end('event: message_stop\ndata: {"type":"message_stop"}\n\n')
        return
      }
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end('{}')
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return { origin: `http://127.0.0.1:${port}`, server, received }
}

test('管理接口未登录一律 401，登录后可动态修改访客策略并即时生效', async (t) => {
  const { app } = await createTestApp({ GUEST_DAILY_MESSAGES: '5' })
  t.after(() => app.close())

  const unauth = await app.inject({ method: 'GET', url: '/api/admin/overview' })
  assert.equal(unauth.statusCode, 401)

  const cookie = await loginCookie(app)

  const patchRes = await app.inject({
    method: 'PATCH',
    url: '/api/admin/policy',
    headers: { cookie, 'content-type': 'application/json' },
    payload: {
      enabled: true,
      dailyMessages: 3,
      allowAttachments: false,
      allowSearch: false,
      allowThinking: false,
    },
  })
  assert.equal(patchRes.statusCode, 200)

  const quotaRes = await app.inject({ method: 'GET', url: '/api/guest/quota' })
  assert.equal(quotaRes.statusCode, 200)
  const { guest } = jsonOf<{
    guest: {
      enabled: boolean
      limit: number
      allowAttachments: boolean
      allowSearch: boolean
      allowThinking: boolean
    }
  }>(quotaRes.body)
  assert.equal(guest.enabled, true)
  assert.equal(guest.limit, 3)
  assert.equal(guest.allowAttachments, false)
  assert.equal(guest.allowSearch, false)
  assert.equal(guest.allowThinking, false)

  // 关闭附件后，访客上传文件和上传表格均被 403 拦截
  const blockedFile = await app.inject({
    method: 'POST',
    url: '/api/gateway/anthropic/v1/files',
  })
  assert.equal(blockedFile.statusCode, 403)
  assert.equal(
    jsonOf<{ error: { code: string } }>(blockedFile.body).error.code,
    'guest_attachments_disabled'
  )

  const blockedSheet = await app.inject({
    method: 'POST',
    url: '/api/spreadsheets',
    headers: { 'x-file-name': 'a.csv', 'content-type': 'text/csv' },
    payload: Buffer.from('a,b\n1,2'),
  })
  assert.equal(blockedSheet.statusCode, 403)
  assert.equal(
    jsonOf<{ error: { code: string } }>(blockedSheet.body).error.code,
    'guest_attachments_disabled'
  )

  // 关闭免费对话总开关后，访客对话返回 401 guest_disabled
  await app.inject({
    method: 'PATCH',
    url: '/api/admin/policy',
    headers: { cookie, 'content-type': 'application/json' },
    payload: { enabled: false },
  })
  const disabledChat = await app.inject({
    method: 'POST',
    url: '/api/gateway/anthropic/v1/messages',
    headers: { 'content-type': 'application/json' },
    payload: { model: 'deepseek-flash', messages: [{ role: 'user', content: 'hi' }] },
  })
  assert.equal(disabledChat.statusCode, 401)
  assert.equal(
    jsonOf<{ error: { code: string } }>(disabledChat.body).error.code,
    'guest_disabled'
  )
})

test('访客对话自动记录完整日志，管理员可按 IP 审计、重置额度与封禁，并强制剥离禁用能力', async (t) => {
  const upstream = await startCapturingUpstream()
  const { app } = await createTestApp({
    DEEPSEEK_ORIGIN: upstream.origin,
    DEEPSEEK_API_KEY: 'sk-test-secret',
    GUEST_DAILY_MESSAGES: '2',
  })
  await app.listen({ host: '127.0.0.1', port: 0 })
  const { port } = app.server.address() as AddressInfo
  const base = `http://127.0.0.1:${port}`
  t.after(() => {
    upstream.server.close()
    return app.close()
  })

  const cookie = await loginCookie(app)

  // 禁止访客搜索与思考，但允许对话和附件
  await app.inject({
    method: 'PATCH',
    url: '/api/admin/policy',
    headers: { cookie, 'content-type': 'application/json' },
    payload: { allowSearch: false, allowThinking: false, allowAttachments: true },
  })

  const resp = await fetch(`${base}/api/gateway/anthropic/v1/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-guest-session-id': 'guest-sess-99',
      'x-guest-files': encodeURIComponent(JSON.stringify(['report.xlsx'])),
    },
    body: JSON.stringify({
      model: 'deepseek-flash',
      thinking: { type: 'enabled' },
      tools: [
        { type: 'deepseek_read_url', name: 'deepseek_read_url' },
        { type: 'deepseek_web_search', name: 'deepseek_web_search' },
      ],
      messages: [{ role: 'user', content: '帮我分析这份报表' }],
      stream: true,
    }),
  })
  assert.equal(resp.status, 200)
  await resp.text()

  // 验证转发到上游的请求已强制关闭 thinking 并剥离 deepseek_web_search
  assert.equal(upstream.received.length, 1)
  const forwarded = upstream.received[0]!
  assert.deepEqual(forwarded.thinking, { type: 'disabled' })
  assert.equal(
    (forwarded.tools as { type: string }[]).some((tool) => tool.type === 'deepseek_web_search'),
    false
  )

  // 管理员查看会话日志，应包含完整提问、回答、附件与 Token 用量
  const logsRes = await app.inject({
    method: 'GET',
    url: '/api/admin/logs',
    headers: { cookie },
  })
  assert.equal(logsRes.statusCode, 200)
  const logs = jsonOf<{
    total: number
    items: {
      ip: string
      sessionId: string
      userContent: string
      assistantContent: string
      assistantThinking: string
      attachments: string[]
      inputTokens: number | null
      outputTokens: number | null
    }[]
  }>(logsRes.body)
  assert.equal(logs.total, 1)
  assert.equal(logs.items[0]?.sessionId, 'guest-sess-99')
  assert.equal(logs.items[0]?.userContent, '帮我分析这份报表')
  assert.equal(logs.items[0]?.assistantContent, '你好，这是测试回答。')
  assert.equal(logs.items[0]?.assistantThinking, '先想一下')
  assert.deepEqual(logs.items[0]?.attachments, ['report.xlsx'])
  assert.equal(logs.items[0]?.inputTokens, 42)
  assert.equal(logs.items[0]?.outputTokens, 18)

  const guestIp = logs.items[0]!.ip

  // 管理员重置该 IP 今日次数 -> 已用清零
  const resetRes = await app.inject({
    method: 'POST',
    url: `/api/admin/visitors/${encodeURIComponent(guestIp)}/reset`,
    headers: { cookie },
  })
  assert.equal(resetRes.statusCode, 200)

  const visitorsRes = await app.inject({
    method: 'GET',
    url: '/api/admin/visitors',
    headers: { cookie },
  })
  const visitors = jsonOf<{ visitors: { ip: string; todayUsed: number }[] }>(visitorsRes.body)
  assert.equal(visitors.visitors.find((v) => v.ip === guestIp)?.todayUsed, 0)

  // 管理员封禁该 IP -> 再次发起免费对话返回 403 guest_ip_blocked
  await app.inject({
    method: 'PATCH',
    url: `/api/admin/visitors/${encodeURIComponent(guestIp)}`,
    headers: { cookie, 'content-type': 'application/json' },
    payload: { blocked: true, note: '滥用测试' },
  })
  const blockedChat = await fetch(`${base}/api/gateway/anthropic/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'deepseek-flash', messages: [{ role: 'user', content: 'hi' }] }),
  })
  assert.equal(blockedChat.status, 403)
  assert.equal(
    jsonOf<{ error: { code: string } }>(await blockedChat.text()).error.code,
    'guest_ip_blocked'
  )
})
