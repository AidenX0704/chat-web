import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createApp } from '../src/app.js'
import {
  createTestApp,
  jsonOf,
  loginCookie,
  sessionCookie,
  TEST_PASSWORD,
  testConfig,
  TEST_USERNAME,
} from './helpers.js'

type ErrorBody = { error: { code: string; message: string } }
type UserBody = {
  user: { id: string; username: string; avatar?: string | null }
  session: { token?: string; expiresAt: number }
}

test('登录后即可访问受保护接口，退出后失效', async (t) => {
  const { app } = await createTestApp()
  t.after(() => app.close())

  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username: TEST_USERNAME, password: TEST_PASSWORD },
  })
  assert.equal(login.statusCode, 200)
  const body = jsonOf<UserBody>(login.body)
  assert.equal(body.user.username, TEST_USERNAME)
  assert.equal(body.session.token, undefined, '未显式要求时不把令牌放进响应体')
  const cookie = sessionCookie(login)

  const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } })
  assert.equal(me.statusCode, 200)
  assert.equal(jsonOf<UserBody>(me.body).user.username, TEST_USERNAME)

  const anonymous = await app.inject({ method: 'GET', url: '/api/auth/me' })
  assert.equal(anonymous.statusCode, 401)

  const logout = await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie } })
  assert.equal(logout.statusCode, 204)

  const afterLogout = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } })
  assert.equal(afterLogout.statusCode, 401, '退出后同一个令牌不能再使用')
})

test('口令错误与用户名错误返回完全相同的响应', async (t) => {
  const { app } = await createTestApp()
  t.after(() => app.close())

  const wrongPassword = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username: TEST_USERNAME, password: 'wrong-password-123' },
  })
  const wrongUsername = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username: 'nobody', password: 'wrong-password-123' },
  })

  assert.equal(wrongPassword.statusCode, 401)
  assert.equal(wrongUsername.statusCode, 401)
  assert.deepEqual(jsonOf<ErrorBody>(wrongPassword.body), jsonOf<ErrorBody>(wrongUsername.body))
})

test('用户名大小写不影响登录', async (t) => {
  const { app } = await createTestApp()
  t.after(() => app.close())

  const upper = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username: TEST_USERNAME.toUpperCase(), password: TEST_PASSWORD },
  })
  assert.equal(upper.statusCode, 200)
})

test('连续失败达到上限后锁定账号，并返回 Retry-After', async (t) => {
  const { app } = await createTestApp({ AUTH_RATE_LIMIT_MAX: '10000' })
  t.after(() => app.close())

  // 前 4 次是普通失败，第 5 次触发锁定，直接返回 429
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const failure = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: TEST_USERNAME, password: 'wrong-password-123' },
    })
    assert.equal(failure.statusCode, attempt < 5 ? 401 : 429)
  }

  const locked = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username: TEST_USERNAME, password: TEST_PASSWORD },
  })
  assert.equal(locked.statusCode, 429, '锁定期间即使口令正确也拒绝登录')
  assert.ok(Number(locked.headers['retry-after']) > 0)
})

test('注册与修改密码接口已移除，账号只由 .env 提供', async (t) => {
  const { app } = await createTestApp()
  t.after(() => app.close())

  const register = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { username: 'alice', password: 'correct-horse-battery' },
  })
  assert.equal(register.statusCode, 404)

  const cookie = await loginCookie(app)
  const changePassword = await app.inject({
    method: 'POST',
    url: '/api/auth/password',
    headers: { cookie },
    payload: { currentPassword: TEST_PASSWORD, newPassword: 'another-good-passphrase' },
  })
  assert.equal(changePassword.statusCode, 404)
})

test('可以单独踢掉某一台设备', async (t) => {
  const { app } = await createTestApp()
  t.after(() => app.close())

  const cookie = await loginCookie(app)
  await loginCookie(app, { userAgent: 'phone' })

  const listed = jsonOf<{ sessions: { id: string; current: boolean }[] }>(
    (await app.inject({ method: 'GET', url: '/api/auth/sessions', headers: { cookie } })).body
  ).sessions
  assert.equal(listed.length, 2)
  assert.equal(listed.filter((session) => session.current).length, 1)

  const other = listed.find((session) => !session.current)
  assert.ok(other, '列表里应有一台非当前设备')
  const revoked = await app.inject({
    method: 'DELETE',
    url: `/api/auth/sessions/${other.id}`,
    headers: { cookie },
  })
  assert.equal(revoked.statusCode, 204)

  const after = jsonOf<{ sessions: unknown[] }>(
    (await app.inject({ method: 'GET', url: '/api/auth/sessions', headers: { cookie } })).body
  )
  assert.equal(after.sessions.length, 1)
})

test('退出其他设备只保留当前设备', async (t) => {
  const { app } = await createTestApp()
  t.after(() => app.close())

  const keep = await loginCookie(app, { userAgent: 'desktop' })
  const drop = await loginCookie(app, { userAgent: 'tablet' })

  const revoked = jsonOf<{ revoked: number }>(
    (await app.inject({ method: 'DELETE', url: '/api/auth/sessions', headers: { cookie: keep } }))
      .body
  )
  assert.equal(revoked.revoked, 1)

  assert.equal(
    (await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: keep } }))
      .statusCode,
    200,
    '当前设备保持登录'
  )
  assert.equal(
    (await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: drop } }))
      .statusCode,
    401,
    '其他设备立即失效'
  )
})

test('跨站部署时必须带合法 Origin，挡住 CSRF', async (t) => {
  const { app } = await createTestApp({ COOKIE_SAMESITE: 'none' })
  t.after(() => app.close())

  const cookie = await loginCookie(app)

  const withoutOrigin = await app.inject({
    method: 'POST',
    url: '/api/auth/logout',
    headers: { cookie },
  })
  assert.equal(withoutOrigin.statusCode, 403)

  const bearerLogin = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username: TEST_USERNAME, password: TEST_PASSWORD },
    headers: { 'x-session-mode': 'bearer' },
  })
  const token = jsonOf<UserBody>(bearerLogin.body).session.token
  assert.ok(token, '显式要求时返回令牌')

  const bearerMe = await app.inject({
    method: 'GET',
    url: '/api/auth/me',
    headers: { authorization: `Bearer ${token ?? ''}` },
  })
  assert.equal(bearerMe.statusCode, 200, 'Bearer 不受 Cookie CSRF 限制')
})

test('聊天代理只转发白名单路径，且必须登录', async (t) => {
  // 关掉访客额度：没有每日免费次数时，未登录一律 401
  const { app } = await createTestApp({
    DEEPSEEK_API_KEY: 'sk-test-placeholder',
    GUEST_DAILY_MESSAGES: '0',
  })
  t.after(() => app.close())

  const anonymous = await app.inject({ method: 'POST', url: '/api/gateway/anthropic/v1/messages' })
  assert.equal(anonymous.statusCode, 401)

  const cookie = await loginCookie(app)

  const blocked = await app.inject({
    method: 'GET',
    url: '/api/gateway/admin/secrets',
    headers: { cookie },
  })
  assert.equal(blocked.statusCode, 403)
  assert.equal(jsonOf<ErrorBody>(blocked.body).error.code, 'path_not_allowed')
})

test('未配置上游密钥时聊天代理明确返回 503', async (t) => {
  const { app } = await createTestApp()
  t.after(() => app.close())

  const cookie = await loginCookie(app)

  const response = await app.inject({
    method: 'POST',
    url: '/api/gateway/anthropic/v1/messages',
    headers: { cookie, 'content-type': 'application/json' },
    payload: { model: 'deepseek-flash', messages: [] },
  })
  assert.equal(response.statusCode, 503)
  assert.equal(jsonOf<ErrorBody>(response.body).error.code, 'proxy_disabled')
})

test('健康检查不需要登录', async (t) => {
  const { app } = await createTestApp()
  t.after(() => app.close())

  const response = await app.inject({ method: 'GET', url: '/api/health' })
  assert.equal(response.statusCode, 200)
  assert.equal(jsonOf<{ status: string }>(response.body).status, 'ok')
})

/** 用一个真实的库文件跑两次启动：口令变了就必须踢掉所有设备 */
const withTempDatabase = async (
  t: { after: (fn: () => void) => void },
  run: (dbPath: string) => Promise<void>
): Promise<void> => {
  const dbPath = join(tmpdir(), `chat-web-rotate-${randomUUID()}.sqlite`)
  t.after(() => {
    for (const suffix of ['', '-wal', '-shm']) {
      rmSync(`${dbPath}${suffix}`, { force: true })
    }
  })
  await run(dbPath)
}

test('.env 口令变更后，所有设备的登录态立即失效', async (t) => {
  await withTempDatabase(t, async (dbPath) => {
    const first = await createApp({
      config: testConfig({ DATABASE_PATH: dbPath }),
      databasePath: dbPath,
    })
    const cookie = await loginCookie(first.app)
    assert.equal(
      (await first.app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } }))
        .statusCode,
      200
    )
    await first.app.close()

    // 同一个库，换口令后再启动一次
    const rotated = 'rotated-passphrase-2026'
    const second = await createApp({
      config: testConfig({ DATABASE_PATH: dbPath, AUTH_PASSWORD: rotated }),
      databasePath: dbPath,
    })
    t.after(() => second.app.close())

    const stale = await second.app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { cookie },
    })
    assert.equal(stale.statusCode, 401, '改口令前签发的 Cookie 必须失效')

    const relogin = await second.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: TEST_USERNAME, password: rotated },
    })
    assert.equal(relogin.statusCode, 200, '新口令可以正常登录')
  })
})

test('口令没变时重启不会踢掉已登录的设备', async (t) => {
  await withTempDatabase(t, async (dbPath) => {
    const first = await createApp({
      config: testConfig({ DATABASE_PATH: dbPath }),
      databasePath: dbPath,
    })
    const cookie = await loginCookie(first.app)
    await first.app.close()

    const second = await createApp({
      config: testConfig({ DATABASE_PATH: dbPath }),
      databasePath: dbPath,
    })
    t.after(() => second.app.close())

    const stillValid = await second.app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { cookie },
    })
    assert.equal(stillValid.statusCode, 200, '口令未变，登录态应当继续有效')
  })
})

test('支持保存与清空用户 base64 头像，并校验格式与体积', async (t) => {
  const { app } = await createTestApp()
  t.after(() => app.close())

  const sampleAvatar =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='

  // 未登录拒绝
  const anonymous = await app.inject({
    method: 'PUT',
    url: '/api/auth/avatar',
    payload: { avatar: sampleAvatar },
  })
  assert.equal(anonymous.statusCode, 401)

  const cookie = await loginCookie(app)

  // 格式非法拒绝
  const invalidFormat = await app.inject({
    method: 'PUT',
    url: '/api/auth/avatar',
    headers: { cookie },
    payload: { avatar: 'https://example.com/avatar.png' },
  })
  assert.equal(invalidFormat.statusCode, 400)
  assert.equal(jsonOf<ErrorBody>(invalidFormat.body).error.code, 'invalid_avatar')

  // 超大体积拒绝
  const oversized = await app.inject({
    method: 'PUT',
    url: '/api/auth/avatar',
    headers: { cookie },
    payload: { avatar: `data:image/webp;base64,${'A'.repeat(270_000)}` },
  })
  assert.equal(oversized.statusCode, 400)
  assert.equal(jsonOf<ErrorBody>(oversized.body).error.code, 'invalid_avatar')

  // 保存合法 base64 头像
  const saved = await app.inject({
    method: 'PUT',
    url: '/api/auth/avatar',
    headers: { cookie },
    payload: { avatar: sampleAvatar },
  })
  assert.equal(saved.statusCode, 200)
  assert.equal(jsonOf<{ user: { avatar: string | null } }>(saved.body).user.avatar, sampleAvatar)

  // GET /me 能读到持久化头像
  const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } })
  assert.equal(me.statusCode, 200)
  assert.equal(jsonOf<UserBody>(me.body).user.avatar, sampleAvatar)

  // 重新登录也能读到最新头像
  const relogin = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username: TEST_USERNAME, password: TEST_PASSWORD },
  })
  assert.equal(relogin.statusCode, 200)
  assert.equal(jsonOf<UserBody>(relogin.body).user.avatar, sampleAvatar)

  // 传 null 清空恢复默认
  const cleared = await app.inject({
    method: 'PUT',
    url: '/api/auth/avatar',
    headers: { cookie },
    payload: { avatar: null },
  })
  assert.equal(cleared.statusCode, 200)
  assert.equal(jsonOf<{ user: { avatar: string | null } }>(cleared.body).user.avatar, null)

  const meAfterClear = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } })
  assert.equal(jsonOf<UserBody>(meAfterClear.body).user.avatar, null)
})
