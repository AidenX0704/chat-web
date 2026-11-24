import { createApp, type AppContext } from '../src/app.js'
import { hashSessionToken, createId, createSessionToken } from '../src/auth/tokens.js'
import { loadConfig, type Config } from '../src/config.js'
import type { Database } from '../src/db/types.js'

/** 测试里固定的唯一账号；服务端只认这一组凭据 */
export const TEST_USERNAME = 'tester'
export const TEST_PASSWORD = 'test-passphrase-2026'

/** 测试默认把限流放宽，避免用例之间互相影响；需要验证限流时单独传入更小的值 */
export const testConfig = (overrides: Record<string, string> = {}): Config =>
  loadConfig({
    NODE_ENV: 'test',
    DATABASE_PATH: ':memory:',
    LOG_LEVEL: 'silent',
    AUTH_USERNAME: TEST_USERNAME,
    AUTH_PASSWORD: TEST_PASSWORD,
    AUTH_RATE_LIMIT_MAX: '10000',
    RATE_LIMIT_MAX: '100000',
    LOGIN_MAX_FAILURES: '5',
    LOGIN_WINDOW_MINUTES: '15',
    LOGIN_LOCK_MINUTES: '15',
    ...overrides,
  })

/** 便于 userCookie 在只拿到 fastify 实例时找到库；仅测试使用 */
const databases = new WeakMap<object, Database>()

export const createTestApp = async (
  overrides: Record<string, string> = {}
): Promise<AppContext> => {
  const context = await createApp({ config: testConfig(overrides), databasePath: ':memory:' })
  databases.set(context.app, context.db)
  return context
}

/** 从 inject 响应里取出会话 Cookie（只取 name=value 部分） */
export const sessionCookie = (response: { headers: Record<string, unknown> }): string => {
  const raw = response.headers['set-cookie']
  const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : []
  const target = list.find((value) => value.startsWith('chat_session='))
  if (!target) {
    throw new Error('响应里没有会话 Cookie')
  }
  return target.split(';')[0] as string
}

export const jsonOf = <T>(payload: string): T => JSON.parse(payload) as T

type App = AppContext['app']

/** 用 .env 里的唯一账号登录，拿一个会话 Cookie */
export const loginCookie = async (
  app: App,
  options: { username?: string; password?: string; userAgent?: string } = {}
): Promise<string> => {
  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: options.userAgent ? { 'user-agent': options.userAgent } : {},
    payload: {
      username: options.username ?? TEST_USERNAME,
      password: options.password ?? TEST_PASSWORD,
    },
  })
  if (response.statusCode !== 200) {
    throw new Error(`登录失败（${response.statusCode}）：${response.body}`)
  }
  return sessionCookie(response)
}

/**
 * 会话行仍然按 user_id 隔离，需要「第二个账号」的用例直接建库拿会话：
 * 单账号登录入口只认 .env 里的账号，这里绕开它是为了让数据隔离用例继续有效。
 */
export const userCookie = (app: App, username: string): string => {
  if (username.trim().toLowerCase() === TEST_USERNAME.toLowerCase()) {
    throw new Error('主账号请用 loginCookie 走真实登录')
  }
  const db = databases.get(app)
  if (!db) {
    throw new Error('createTestApp 创建的 app 才能拿到数据库')
  }
  const at = Date.now()
  const userId = createId()
  db.prepare(
    `INSERT INTO users (id, username, username_normalized, password_hash, status, created_at, updated_at, password_changed_at, last_login_at)
     VALUES (?, ?, ?, ?, 'active', ?, ?, ?, NULL)`
  ).run(userId, username, username.trim().toLowerCase(), 'unused-in-tests', at, at, at)
  const token = createSessionToken()
  db.prepare(
    `INSERT INTO auth_sessions (id, user_id, token_hash, created_at, last_used_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(createId(), userId, hashSessionToken(token), at, at, at + 30 * 24 * 60 * 60 * 1000)
  return `chat_session=${token}`
}
