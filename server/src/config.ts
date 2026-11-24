/**
 * 环境变量解析：所有可调参数集中在这里，启动时一次性校验，
 * 配置错误直接拒绝启动，避免带着不安全的默认值上线。
 */

export type AppEnv = 'development' | 'production' | 'test'

export type LoginPolicy = {
  /** 同一账号 / 同一 IP 允许的连续失败次数 */
  maxFailures: number
  /** 失败计数窗口 */
  windowMs: number
  /** 触发上限后的锁定时长 */
  lockMs: number
}

export type ChatProxyConfig = {
  enabled: boolean
  /** DeepSeek 上游地址，不带尾斜杠 */
  origin: string
  /** 服务端持有的 API Key，绝不下发给浏览器 */
  apiKey: string | null
  /** 单个请求体大小上限（附件上传按此限制） */
  maxBodyBytes: number
  /** 单个用户同时在途的代理请求数上限 */
  maxConcurrentPerUser: number
  /** 允许转发的路径前缀，避免成为任意地址的开放代理 */
  allowedPrefixes: string[]
}

/** 未登录访客的每日对话额度（按客户端 IP 计） */
export type GuestConfig = {
  /** 每天可用的对话次数；0 表示不开放访客对话，必须登录 */
  dailyMessages: number
}

export type Config = {
  env: AppEnv
  host: string
  port: number
  logLevel: string
  databasePath: string
  corsOrigins: string[]
  cookieName: string
  cookieSecure: boolean
  cookieSameSite: 'lax' | 'strict' | 'none'
  cookieDomain: string | undefined
  /** 会话绝对有效期 */
  sessionTtlMs: number
  /** 会话空闲有效期，每次使用后顺延但不超过绝对有效期 */
  sessionIdleMs: number
  maxSessionsPerUser: number
  /** 唯一账号：用户名与口令都来自 .env，服务端不提供注册入口 */
  account: { username: string; password: string }
  trustProxy: boolean
  /** 附件原件目录 */
  dataDir: string
  /** 会话相关限额 */
  chats: { maxBytes: number; maxPerUser: number }
  /** 附件相关限额 */
  files: { maxBytes: number; quotaBytes: number }
  /** 全局按 IP 的请求上限 */
  globalRateLimit: { max: number; windowMs: number }
  /** 登录按 IP 的请求上限（口令散列很贵，限得比全局严） */
  authRateLimit: { max: number; windowMs: number }
  login: LoginPolicy
  guest: GuestConfig
  chatProxy: ChatProxyConfig
}

type Env = Record<string, string | undefined>

/** 配置错误直接拒绝启动；用 throw 让类型收窄生效 */
const configError = (message: string): Error => new Error(`配置错误：${message}`)

const readString = (env: Env, key: string): string | undefined => {
  const raw = env[key]
  if (raw === undefined) {
    return undefined
  }
  const value = raw.trim()
  return value === '' ? undefined : value
}

/** .env.example 里的示例口令：忘了改就拒绝启动，避免用一个人尽皆知的口令上线 */
const PLACEHOLDER_PASSWORD = 'change-me-to-a-long-random-passphrase'

/** 口令不做 trim：改掉用户输入的首尾空格会让口令变成另一个值 */
const readSecret = (env: Env, key: string): string | undefined => {
  const raw = env[key]
  return raw === undefined || raw === '' ? undefined : raw
}

/**
 * 个人账号：整个服务只有这一个账号，凭据只从 .env 读。
 * 缺任何一项都直接拒绝启动，避免出现「没有账号」或「空口令」的可用状态。
 */
const readAccount = (env: Env): Config['account'] => {
  const username = readString(env, 'AUTH_USERNAME')
  const password = readSecret(env, 'AUTH_PASSWORD')
  if (username === undefined) {
    throw configError('未配置 AUTH_USERNAME（个人账号用户名）')
  }
  if (password === undefined) {
    throw configError('未配置 AUTH_PASSWORD（个人账号口令）')
  }
  if (!/^[\p{L}\p{N}_.@-]{1,32}$/u.test(username)) {
    throw configError('AUTH_USERNAME 只能包含字母、数字与 _ . @ -，且不超过 32 个字符')
  }
  if (password === PLACEHOLDER_PASSWORD) {
    throw configError('AUTH_PASSWORD 还是 .env.example 里的示例值，请改成你自己的口令')
  }
  if (password.length < 8) {
    throw configError('AUTH_PASSWORD 至少需要 8 个字符')
  }
  if (password.length > 128) {
    throw configError('AUTH_PASSWORD 最多 128 个字符')
  }
  if (password.length < 12) {
    // eslint-disable-next-line no-console
    console.warn('[config] AUTH_PASSWORD 不足 12 个字符，建议换一个更长的口令。')
  }
  return { username, password }
}

const readBool = (env: Env, key: string, fallback: boolean): boolean => {
  const value = readString(env, key)
  if (value === undefined) {
    return fallback
  }
  if (/^(1|true|yes|on)$/i.test(value)) {
    return true
  }
  if (/^(0|false|no|off)$/i.test(value)) {
    return false
  }
  throw configError(`${key} 需要是 true/false，当前为 ${value}`)
}

const readInt = (env: Env, key: string, fallback: number, range: { min: number; max: number }): number => {
  const value = readString(env, key)
  if (value === undefined) {
    return fallback
  }
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
    throw configError(`${key} 需要是整数，当前为 ${value}`)
  }
  if (parsed < range.min || parsed > range.max) {
    throw configError(`${key} 需要在 ${range.min} 到 ${range.max} 之间，当前为 ${parsed}`)
  }
  return parsed
}

const DAY_MS = 24 * 60 * 60 * 1000
const MB = 1024 * 1024

/** 解析环境变量；env 默认为 process.env，测试时可注入。 */
export const loadConfig = (env: Env = process.env): Config => {
  const nodeEnv = readString(env, 'NODE_ENV') ?? 'development'
  if (nodeEnv !== 'development' && nodeEnv !== 'production' && nodeEnv !== 'test') {
    throw configError(`NODE_ENV 需要是 development / production / test，当前为 ${nodeEnv}`)
  }
  const appEnv: AppEnv = nodeEnv
  const production = appEnv === 'production'

  const sameSiteRaw = readString(env, 'COOKIE_SAMESITE') ?? (production ? 'lax' : 'lax')
  if (sameSiteRaw !== 'lax' && sameSiteRaw !== 'strict' && sameSiteRaw !== 'none') {
    throw configError(`COOKIE_SAMESITE 需要是 lax / strict / none，当前为 ${sameSiteRaw}`)
  }

  const corsOrigins = (readString(env, 'CORS_ORIGINS') ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin !== '')

  const deepseekOrigin = (readString(env, 'DEEPSEEK_ORIGIN') ?? 'https://api.deepseek.com').replace(/\/+$/, '')
  const deepseekApiKey = readString(env, 'DEEPSEEK_API_KEY') ?? null

  if (production && corsOrigins.length === 0) {
    // 不配置来源时只允许同源访问；这里提醒一次而不阻断，便于单机同源部署。
    // eslint-disable-next-line no-console
    console.warn('[config] 未配置 CORS_ORIGINS，将只接受同源请求。')
  }
  if (production && deepseekApiKey === null) {
    // eslint-disable-next-line no-console
    console.warn('[config] 未配置 DEEPSEEK_API_KEY，聊天代理不可用。')
  }

  return {
    env: appEnv,
    host: readString(env, 'HOST') ?? '127.0.0.1',
    port: readInt(env, 'PORT', 8787, { min: 1, max: 65535 }),
    logLevel: readString(env, 'LOG_LEVEL') ?? (production ? 'info' : 'debug'),
    databasePath: readString(env, 'DATABASE_PATH') ?? './data/chat-personal.sqlite',
    dataDir: readString(env, 'DATA_DIR') ?? './data/files',
    chats: {
      // 单条会话正文（含全部分支消息）上限，超过多半是前端出了问题
      maxBytes: readInt(env, 'CHAT_MAX_MB', 8, { min: 1, max: 64 }) * MB,
      maxPerUser: readInt(env, 'CHATS_MAX_PER_USER', 5000, { min: 1, max: 100000 }),
    },
    files: {
      // 与前端上传单个附件的上限对齐（文档/图片 64MB，user_data 32MB）
      maxBytes: readInt(env, 'FILE_MAX_MB', 64, { min: 1, max: 512 }) * MB,
      quotaBytes: readInt(env, 'FILES_QUOTA_MB', 2048, { min: 1, max: 1024 * 1024 }) * MB,
    },
    corsOrigins,
    cookieName: readString(env, 'COOKIE_NAME') ?? 'chat_session',
    cookieSecure: readBool(env, 'COOKIE_SECURE', production),
    cookieSameSite: sameSiteRaw,
    cookieDomain: readString(env, 'COOKIE_DOMAIN'),
    sessionTtlMs: readInt(env, 'SESSION_TTL_DAYS', 30, { min: 1, max: 365 }) * DAY_MS,
    sessionIdleMs: readInt(env, 'SESSION_IDLE_DAYS', 14, { min: 1, max: 365 }) * DAY_MS,
    maxSessionsPerUser: readInt(env, 'MAX_SESSIONS_PER_USER', 10, { min: 1, max: 100 }),
    account: readAccount(env),
    trustProxy: readBool(env, 'TRUST_PROXY', false),
    globalRateLimit: {
      max: readInt(env, 'RATE_LIMIT_MAX', 600, { min: 1, max: 100000 }),
      windowMs: readInt(env, 'RATE_LIMIT_WINDOW_SECONDS', 60, { min: 1, max: 3600 }) * 1000,
    },
    authRateLimit: {
      max: readInt(env, 'AUTH_RATE_LIMIT_MAX', 10, { min: 1, max: 100000 }),
      windowMs: readInt(env, 'AUTH_RATE_LIMIT_WINDOW_SECONDS', 60, { min: 1, max: 3600 }) * 1000,
    },
    login: {
      maxFailures: readInt(env, 'LOGIN_MAX_FAILURES', 5, { min: 3, max: 50 }),
      windowMs: readInt(env, 'LOGIN_WINDOW_MINUTES', 15, { min: 1, max: 1440 }) * 60 * 1000,
      lockMs: readInt(env, 'LOGIN_LOCK_MINUTES', 15, { min: 1, max: 1440 }) * 60 * 1000,
    },
    guest: {
      // 未登录也能先聊几句：按 IP 每天限量，登录后不再受限
      dailyMessages: readInt(env, 'GUEST_DAILY_MESSAGES', 10, { min: 0, max: 1000 }),
    },
    chatProxy: {
      enabled: deepseekApiKey !== null,
      origin: deepseekOrigin,
      apiKey: deepseekApiKey,
      maxBodyBytes: readInt(env, 'PROXY_MAX_BODY_MB', 100, { min: 1, max: 512 }) * MB,
      maxConcurrentPerUser: readInt(env, 'PROXY_MAX_CONCURRENT_PER_USER', 8, { min: 1, max: 64 }),
      allowedPrefixes: ['anthropic/v1/', 'v1/tools/', 'audio/', 'models'],
    },
  }
}
