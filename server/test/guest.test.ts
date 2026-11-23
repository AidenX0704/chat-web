import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import test from 'node:test'
import { createTestApp, jsonOf, loginCookie } from './helpers.js'

/** 假上游：对话请求回一条最小 SSE，其余接口回 {} */
const startMockUpstream = async (): Promise<{ origin: string; server: Server }> => {
  const server = createServer((request, response) => {
    request.resume()
    request.on('end', () => {
      if (request.url?.startsWith('/anthropic/v1/messages')) {
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        response.end('event: message_stop\ndata: {"type":"message_stop"}\n\n')
        return
      }
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end('{}')
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return { origin: `http://127.0.0.1:${port}`, server }
}

type GuestQuotaBody = {
  guest: { limit: number; used: number; remaining: number; resetAt: number }
}
type ErrorBody = { error: { code: string; message: string } }

/** 起一个真的监听端口：注入式请求碰不到 reply.hijack 里的代理流 */
const startApp = async (
  overrides: Record<string, string>
): Promise<{ base: string; app: Awaited<ReturnType<typeof createTestApp>>['app'] }> => {
  const { app } = await createTestApp(overrides)
  await app.listen({ host: '127.0.0.1', port: 0 })
  const { port } = app.server.address() as AddressInfo
  return { base: `http://127.0.0.1:${port}`, app }
}

const chat = (base: string, headers: Record<string, string> = {}): Promise<Response> =>
  fetch(`${base}/api/gateway/anthropic/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ model: 'deepseek-flash', stream: true, messages: [] }),
  })

test('未登录访客每天有固定次数的对话额度，用完后返回 429', async (t) => {
  const upstream = await startMockUpstream()
  const { base, app } = await startApp({
    DEEPSEEK_ORIGIN: upstream.origin,
    DEEPSEEK_API_KEY: 'sk-server-side-secret',
    GUEST_DAILY_MESSAGES: '2',
  })
  t.after(() => {
    upstream.server.close()
    return app.close()
  })

  const before = jsonOf<GuestQuotaBody>(
    await (await fetch(`${base}/api/guest/quota`)).text()
  )
  assert.equal(before.guest.limit, 2)
  assert.equal(before.guest.remaining, 2)
  assert.ok(before.guest.resetAt > Date.now(), '应给出额度重置时间')

  const first = await chat(base)
  assert.equal(first.status, 200)
  assert.equal(first.headers.get('x-guest-quota-remaining'), '1')
  await first.text()

  const second = await chat(base)
  assert.equal(second.status, 200)
  assert.equal(second.headers.get('x-guest-quota-remaining'), '0')
  await second.text()

  const third = await chat(base)
  assert.equal(third.status, 429)
  assert.equal(jsonOf<ErrorBody>(await third.text()).error.code, 'guest_quota_exhausted')
  assert.ok(Number(third.headers.get('retry-after')) > 0, '应告诉客户端多久后可以再试')

  const after = jsonOf<GuestQuotaBody>(await (await fetch(`${base}/api/guest/quota`)).text())
  assert.equal(after.guest.used, 2)
  assert.equal(after.guest.remaining, 0)
})

test('访客只能用对话与附件，登录用户不占访客额度', async (t) => {
  const upstream = await startMockUpstream()
  const { base, app } = await startApp({
    DEEPSEEK_ORIGIN: upstream.origin,
    DEEPSEEK_API_KEY: 'sk-server-side-secret',
    GUEST_DAILY_MESSAGES: '5',
  })
  t.after(() => {
    upstream.server.close()
    return app.close()
  })

  // 访客碰不到语音接口：白名单之外一律 403
  const speech = await fetch(`${base}/api/gateway/audio/speech`, { method: 'POST' })
  assert.equal(speech.status, 403)
  assert.equal(jsonOf<ErrorBody>(await speech.text()).error.code, 'guest_not_allowed')

  // 登录用户走原来的鉴权分支，不扣访客次数
  const cookie = await loginCookie(app)
  const signedIn = await chat(base, { cookie })
  assert.equal(signedIn.status, 200)
  await signedIn.text()

  const quota = jsonOf<GuestQuotaBody>(await (await fetch(`${base}/api/guest/quota`)).text())
  assert.equal(quota.guest.used, 0)
})
