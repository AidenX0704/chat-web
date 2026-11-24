import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import test from 'node:test'
import { createTestApp, loginCookie } from './helpers.js'

/** 假上游：/messages 按帧吐 SSE，其余接口回显收到的请求信息 */
const startMockUpstream = async (): Promise<{ origin: string; server: Server; seen: string[] }> => {
  const seen: string[] = []
  const server = createServer((request, response) => {
    seen.push(`${request.method} ${request.url ?? ''}`)
    if (request.url?.startsWith('/anthropic/v1/messages')) {
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      let frames = 0
      const timer = setInterval(() => {
        frames += 1
        response.write(
          `event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"text":"f${frames}"}}\n\n`
        )
        if (frames === 3) {
          clearInterval(timer)
          response.end('event: message_stop\ndata: {"type":"message_stop"}\n\n')
        }
      }, 30)
      return
    }
    let bytes = 0
    request.on('data', (chunk: Buffer) => {
      bytes += chunk.length
    })
    request.on('end', () => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(
        JSON.stringify({
          bytes,
          apiKey: request.headers['x-api-key'] ?? null,
          hasCookie: Boolean(request.headers.cookie),
        })
      )
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return { origin: `http://127.0.0.1:${port}`, server, seen }
}

test('代理把 SSE 逐帧透传，并用服务端密钥替换客户端密钥', async (t) => {
  const upstream = await startMockUpstream()
  const { app } = await createTestApp({
    DEEPSEEK_ORIGIN: upstream.origin,
    DEEPSEEK_API_KEY: 'sk-server-side-secret',
  })
  t.after(() => {
    upstream.server.close()
    return app.close()
  })

  const cookie = await loginCookie(app)
  await app.listen({ host: '127.0.0.1', port: 0 })
  const address = app.server.address() as AddressInfo
  const base = `http://127.0.0.1:${address.port}`

  const startedAt = Date.now()
  const response = await fetch(`${base}/api/gateway/anthropic/v1/messages`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json', 'x-api-key': 'sk-attacker' },
    body: JSON.stringify({ model: 'deepseek-flash', stream: true, messages: [] }),
  })
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('content-type'), 'text/event-stream')
  assert.equal(response.headers.get('x-accel-buffering'), 'no')

  const timings: number[] = []
  const decoder = new TextDecoder()
  let text = ''
  const reader = response.body?.getReader()
  assert.ok(reader)
  for (;;) {
    const { done, value } = await reader.read()
    if (done) {
      break
    }
    timings.push(Date.now() - startedAt)
    text += decoder.decode(value)
  }

  assert.equal(timings.length, 3, '三帧应分别到达，说明没有被整体缓冲')
  assert.ok((timings[2] ?? 0) > (timings[0] ?? 0) + 40, '首帧应明显早于末帧到达')
  assert.ok(text.includes('message_stop'))

  const uploaded = await fetch(`${base}/api/gateway/anthropic/v1/files`, {
    method: 'POST',
    headers: { cookie, 'x-api-key': 'sk-attacker' },
    body: new FormData(),
  })
  const body = (await uploaded.json()) as { apiKey: string | null; hasCookie: boolean }
  assert.equal(body.apiKey, 'sk-server-side-secret', '客户端伪造的密钥必须被丢弃')
  assert.equal(body.hasCookie, false, '登录 Cookie 不能泄漏给上游')

  assert.deepEqual(upstream.seen, [
    'POST /anthropic/v1/messages',
    'POST /anthropic/v1/files',
  ])
})
