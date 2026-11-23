import cookie from '@fastify/cookie'
import cors from '@fastify/cors'
import helmet from '@fastify/helmet'
import rateLimit from '@fastify/rate-limit'
import Fastify, { type FastifyInstance } from 'fastify'
import { loadPersonalAccount } from './auth/account.js'
import { registerAuthenticateDecorator } from './auth/authenticate.js'
import { authRoutes } from './auth/routes.js'
import { createAuthService, type AuthService } from './auth/service.js'
import type { Config } from './config.js'
import { createAuthEventRepo } from './db/authEvents.js'
import { createAuthSessionRepo } from './db/authSessions.js'
import { openDatabase, type Database } from './db/index.js'
import { createGuestLogRepo } from './db/guestLogs.js'
import { createGuestPolicyRepo } from './db/guestPolicy.js'
import { createGuestQuotaRepo } from './db/guestQuota.js'
import { createThrottleRepo } from './db/throttle.js'
import { createUserRepo } from './db/users.js'
import { createShareRepo } from './db/shares.js'
import { createChatEventHub, type ChatEventHub } from './lib/chatEvents.js'
import { HttpError } from './lib/errors.js'
import { redactPaths } from './lib/logger.js'
import { adminRoutes } from './routes/admin.js'
import { chatProxyRoutes } from './routes/chatProxy.js'
import { guestRoutes } from './routes/guest.js'
import { chatRoutes } from './routes/chats.js'
import { shareManageRoutes, shareRoutes } from './routes/shares.js'
import { fileRoutes } from './routes/files.js'
import { spreadsheetRoutes } from './routes/spreadsheets.js'
import { createBlobStore } from './storage/blobs.js'
import { createSpreadsheetStore } from './spreadsheets/store.js'
import { createChatRepo } from './db/chats.js'
import { createUserFileRepo } from './db/userFiles.js'
import { healthRoutes } from './routes/health.js'

/** 事件日志保留 90 天，够做安全回溯又不至于无限增长 */
const EVENT_RETENTION_MS = 90 * 24 * 60 * 60 * 1000
const MAINTENANCE_INTERVAL_MS = 60 * 60 * 1000
/** 删除墓碑保留 7 天：正常客户端每次打开都会重拉会话，不需要保留太久 */
const DELETION_RETENTION_MS = 7 * 24 * 60 * 60 * 1000

/** 错误处理里关心的字段：Node / Fastify / SQLite 的错误对象都是这个形状的子集 */
type ApiFailure = Error & { code?: string; statusCode?: number }

export type CreateAppOptions = {
  config: Config
  /** 覆盖数据库路径，测试用 ':memory:' */
  databasePath?: string
  clock?: () => number
  /** SSE 心跳间隔（测试用） */
  sseHeartbeatMs?: number
}

export type AppContext = {
  app: FastifyInstance
  db: Database
  service: AuthService
  config: Config
  hub: ChatEventHub
}

export const createApp = async (options: CreateAppOptions): Promise<AppContext> => {
  const { config } = options
  const db = openDatabase(options.databasePath ?? config.databasePath)

  const users = createUserRepo(db)
  const chats = createChatRepo(db)
  const shares = createShareRepo(db)
  const userFiles = createUserFileRepo(db)
  const blobs = createBlobStore(config.dataDir)
  await blobs.ensureRoot()
  const spreadsheets = createSpreadsheetStore(config.dataDir)
  await spreadsheets.ensureRoot()
  const sessions = createAuthSessionRepo(db)
  const throttle = createThrottleRepo(db, config.login)
  const guestPolicy = createGuestPolicyRepo(db, config.guest.dailyMessages)
  const guestQuota = createGuestQuotaRepo(db, (ip) => guestPolicy.effectiveLimitFor(ip))
  const guestLogs = createGuestLogRepo(db)
  const events = createAuthEventRepo(db)
  // 唯一账号从 .env 读取；这里把账号行同步进库，历史会话的 user_id 因此保持不变
  const bootedAt = Date.now()
  const account = await loadPersonalAccount({ config, users, at: bootedAt })
  const service = createAuthService({ config, account, users, sessions, throttle, events })
  const hub = createChatEventHub()

  const app = Fastify({
    logger: {
      level: config.logLevel,
      redact: { paths: redactPaths, censor: '[redacted]' },
    },
    trustProxy: config.trustProxy,
    // JSON 接口本身很小；附件走流式通道，由代理层单独计字节
    bodyLimit: 8 * 1024 * 1024,
  })

  if (account.passwordChanged) {
    // 口令换了就等于旧凭据作废：之前下发的登录态全部吊销，每台设备都必须用新口令重新登录
    const revoked = sessions.revokeAll(account.user.id, bootedAt)
    events.record({
      type: 'session_revoked',
      at: bootedAt,
      userId: account.user.id,
      username: account.user.username,
      detail: `env_password_changed revoked=${revoked}`,
    })
    app.log.warn(
      { account: account.user.username, revoked },
      '.env 里的账号口令已变更，已吊销该账号的全部登录态'
    )
  }

  await app.register(helmet, {
    // 服务只返回 JSON / 音频流，不渲染 HTML，关掉 CSP 避免误伤
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: { policy: 'same-site' },
    referrerPolicy: { policy: 'no-referrer' },
  })

  await app.register(cookie)

  await app.register(cors, {
    // 未配置白名单时不做跨域，只服务同源部署
    origin: config.corsOrigins.length === 0 ? false : config.corsOrigins,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'content-type',
      'authorization',
      'x-session-mode',
      'x-requested-with',
      'x-client-id',
      'last-event-id',
      'x-file-name',
      'x-file-id',
      'x-guest-session-id',
      'x-guest-files',
    ],
    exposedHeaders: ['retry-after'],
    maxAge: 86400,
  })

  // 全局兜底限流：单机十余人使用，正常交互远低于这个量级
  await app.register(rateLimit, {
    global: true,
    max: config.globalRateLimit.max,
    timeWindow: config.globalRateLimit.windowMs,
    allowList: [],
    keyGenerator: (request) => request.ip,
  })

  registerAuthenticateDecorator(app, { service, config, clock: options.clock })

  // 代理需要拿到未解析的请求流（multipart 上传、SSE 回包都靠它直通）
  app.addContentTypeParser('*', (_request, payload, done) => {
    done(null, payload)
  })

  app.setNotFoundHandler((request, reply) => {
    reply.code(404).send({
      error: { code: 'not_found', message: `未知接口 ${request.method} ${request.url}` },
    })
  })

  app.setErrorHandler((error: ApiFailure, request, reply) => {
    if (error instanceof HttpError) {
      if (error.retryAfterMs !== undefined && error.retryAfterMs > 0) {
        reply.header('retry-after', String(Math.ceil(error.retryAfterMs / 1000)))
      }
      reply.code(error.statusCode).send({
        error: {
          code: error.code,
          message: error.expose ? error.message : '服务器内部错误',
        },
      })
      return
    }
    const code = error.code
    if (code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
      reply.code(413).send({ error: { code: 'payload_too_large', message: '请求体过大' } })
      return
    }
    if (code === 'FST_ERR_CTP_INVALID_MEDIA_TYPE') {
      reply
        .code(415)
        .send({ error: { code: 'unsupported_media_type', message: '不支持的请求类型' } })
      return
    }
    if (code === 'SQLITE_CONSTRAINT_UNIQUE' || code === 'SQLITE_CONSTRAINT_PRIMARYKEY') {
      reply.code(409).send({ error: { code: 'conflict', message: '资源已存在' } })
      return
    }
    if (error.statusCode === 429) {
      reply
        .code(429)
        .send({ error: { code: 'too_many_requests', message: '请求过于频繁，请稍后再试' } })
      return
    }
    if (error.statusCode !== undefined && error.statusCode < 500) {
      reply.code(error.statusCode).send({
        error: { code: 'invalid_request', message: error.message },
      })
      return
    }
    request.log.error({ err: error }, '未处理的服务端错误')
    reply.code(500).send({ error: { code: 'internal_error', message: '服务器内部错误' } })
  })

  const startedAt = Date.now()
  await app.register(healthRoutes, { config, startedAt })
  await app.register(authRoutes, { prefix: '/api/auth', service, config, hub })
  await app.register(chatRoutes, {
    config,
    chats,
    shares,
    files: userFiles,
    blobs,
    spreadsheets,
    hub,
    sseHeartbeatMs: options.sseHeartbeatMs,
  })
  // 分享页公开可读：不挂登录校验，凭令牌取一份只读快照
  await app.register(shareRoutes, { shares })
  // 分享链接管理：列在自己的名下，撤销后链接立即失效
  await app.register(shareManageRoutes, { shares })
  await app.register(fileRoutes, { config, chats, files: userFiles, blobs })
  // 大表格结构化解析、分页预览与只读工具查询
  await app.register(spreadsheetRoutes, { config, spreadsheets, policy: guestPolicy })
  // 访客额度与可用能力查询：不挂登录校验，未登录也能实时获知当前策略
  await app.register(guestRoutes, { quota: guestQuota, policy: guestPolicy })
  // 管理员后台：仅唯一登录账号可访问，用于管理访客策略、IP 额度与会话详情
  await app.register(adminRoutes, { policy: guestPolicy, quota: guestQuota, guestLogs })
  await app.register(chatProxyRoutes, {
    config,
    quota: guestQuota,
    policy: guestPolicy,
    guestLogs,
  })

  // 定期清理过期数据，避免表无限增长
  const maintenance = setInterval(() => {
    try {
      const at = Date.now()
      sessions.prune(at)
      throttle.prune(at)
      events.prune(at, EVENT_RETENTION_MS)
      chats.pruneDeletions(at - DELETION_RETENTION_MS)
      guestQuota.prune(at)
      guestLogs.prune(at)
      // 上传后没被任何会话引用（中途取消、页面关闭）的原件，一天后清掉
      for (const orphan of userFiles.listOrphans(at - EVENT_RETENTION_MS)) {
        userFiles.remove(orphan.user_id, orphan.id)
        void blobs.remove(orphan.user_id, orphan.id)
        void spreadsheets.remove(`user:${orphan.user_id}`, orphan.id)
      }
      // 访客上传的临时表格 SQLite 超过 24 小时自动清理
      void spreadsheets.pruneGuests(24 * 60 * 60 * 1000)
    } catch (error) {
      app.log.warn({ err: error }, '清理过期数据失败')
    }
  }, MAINTENANCE_INTERVAL_MS)
  maintenance.unref()

  app.addHook('onClose', async () => {
    clearInterval(maintenance)
    hub.closeAll()
    db.pragma('optimize')
    db.close()
  })

  return { app, db, service, config, hub }
}
