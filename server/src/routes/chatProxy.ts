import { randomUUID } from 'node:crypto'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { Transform } from 'node:stream'
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import type { Config } from '../config.js'
import type { GuestLogRepo } from '../db/guestLogs.js'
import type { GuestPolicyRepo } from '../db/guestPolicy.js'
import { dayKeyOf, type GuestQuotaRepo } from '../db/guestQuota.js'
import { HttpError, forbidden, payloadTooLarge, unauthorized } from '../lib/errors.js'

/** 逐跳头不能转发 */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])

/** 客户端专用头，绝不能透传到上游（凭据必须换成服务端自己的） */
const CLIENT_ONLY = new Set([
  'host',
  'cookie',
  'authorization',
  'x-api-key',
  'content-length',
  'origin',
  'referer',
  'x-guest-session-id',
  'x-guest-files',
])

/** 上游空闲超时：长回复靠数据帧保活，真的卡死才断开 */
const UPSTREAM_TIMEOUT_MS = 10 * 60 * 1000

/** 访客能用到的路径：对话与附件上传，其余（语音、模型列表）留给登录用户 */
const GUEST_PATHS = ['anthropic/v1/messages', 'anthropic/v1/files']
/** 真正产生生成费用、需要扣访客每日次数的路径 */
const GUEST_COUNTED_PATHS = ['anthropic/v1/messages']

/** 允许带子路径（如 files/<id>）的匹配；'models' 这类定值路径也走这里 */
const matchesPath = (trailing: string, path: string): boolean =>
  trailing === path || trailing.startsWith(`${path}/`)

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

export type ChatProxyOptions = {
  config: Config
  /** 未登录访客的每日对话额度 */
  quota: GuestQuotaRepo
  /** 管理员动态配置的访客策略与 IP 规则 */
  policy: GuestPolicyRepo
  /** 免登录访客会话日志仓库 */
  guestLogs: GuestLogRepo
}

/** 访客额度响应头：本次扣减后还剩几次，前端据此更新提示 */
const guestQuotaHeaders = (request: FastifyRequest): Record<string, string> => {
  const quota = request.guestQuota
  if (!quota) {
    return {}
  }
  return {
    'x-guest-quota-limit': String(quota.limit),
    'x-guest-quota-remaining': String(quota.remaining),
  }
}

type GuestCaptureMeta = {
  id: string
  ip: string
  sessionId: string
  userAgent: string | null
  model: string
  thinking: boolean
  search: boolean
  attachments: string[]
  userContent: string
  createdAt: number
}

const parseGuestFilesHeader = (header: unknown): string[] => {
  if (typeof header !== 'string' || header.trim() === '') {
    return []
  }
  try {
    const decoded = decodeURIComponent(header.trim())
    const parsed = JSON.parse(decoded) as unknown
    if (Array.isArray(parsed)) {
      return parsed
        .filter((item): item is string => typeof item === 'string' && item.trim() !== '')
        .slice(0, 50)
    }
  } catch {
    // 忽略格式异常的辅助头
  }
  return []
}

const hasAttachmentBlocks = (messages: unknown): boolean => {
  if (!Array.isArray(messages)) {
    return false
  }
  for (const msg of messages) {
    if (!isRecord(msg) || msg.role !== 'user' || !Array.isArray(msg.content)) {
      continue
    }
    for (const block of msg.content) {
      if (isRecord(block) && (block.type === 'image' || block.type === 'document')) {
        return true
      }
    }
  }
  return false
}

const extractLastUserText = (messages: unknown): { text: string; fileCount: number } => {
  if (!Array.isArray(messages)) {
    return { text: '', fileCount: 0 }
  }
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i]
    if (!isRecord(msg) || msg.role !== 'user') {
      continue
    }
    if (typeof msg.content === 'string') {
      return { text: msg.content, fileCount: 0 }
    }
    if (Array.isArray(msg.content)) {
      const texts: string[] = []
      let fileCount = 0
      for (const block of msg.content) {
        if (!isRecord(block)) {
          continue
        }
        if (block.type === 'text' && typeof block.text === 'string') {
          texts.push(block.text)
        } else if (block.type === 'image' || block.type === 'document') {
          fileCount += 1
        }
      }
      // 有结构化表格画像块时，最后一段通常是用户真实提问；合并展示但避免太冗长
      return { text: texts.join('\n\n'), fileCount }
    }
  }
  return { text: '', fileCount: 0 }
}

/** 轻量级旁路 SSE 解析器：无缓冲地从上游流中提取回答正文、思考、Token 用量与错误 */
const createGuestSseCollector = () => {
  let buffer = ''
  let assistantContent = ''
  let assistantThinking = ''
  let stopReason: string | null = null
  let inputTokens: number | null = null
  let outputTokens: number | null = null
  let errorMessage: string | null = null
  let sawStop = false

  const consumeData = (raw: string) => {
    let payload: unknown
    try {
      payload = JSON.parse(raw) as unknown
    } catch {
      return
    }
    if (!isRecord(payload)) {
      return
    }
    if (isRecord(payload.error) && typeof payload.error.message === 'string') {
      errorMessage = payload.error.message
      return
    }
    const type = payload.type
    if (type === 'message_start' && isRecord(payload.message) && isRecord(payload.message.usage)) {
      const u = payload.message.usage
      const inp =
        (typeof u.input_tokens === 'number' ? u.input_tokens : 0) +
        (typeof u.cache_creation_input_tokens === 'number' ? u.cache_creation_input_tokens : 0) +
        (typeof u.cache_read_input_tokens === 'number' ? u.cache_read_input_tokens : 0)
      if (inp > 0) {
        inputTokens = inp
      }
      return
    }
    if (type === 'content_block_delta' && isRecord(payload.delta)) {
      if (payload.delta.type === 'text_delta' && typeof payload.delta.text === 'string') {
        assistantContent += payload.delta.text
      } else if (
        payload.delta.type === 'thinking_delta' &&
        typeof payload.delta.thinking === 'string'
      ) {
        assistantThinking += payload.delta.thinking
      }
      return
    }
    if (type === 'message_delta') {
      if (isRecord(payload.delta) && typeof payload.delta.stop_reason === 'string') {
        stopReason = payload.delta.stop_reason
      }
      if (isRecord(payload.usage)) {
        const u = payload.usage
        const inp =
          (typeof u.input_tokens === 'number' ? u.input_tokens : 0) +
          (typeof u.cache_creation_input_tokens === 'number' ? u.cache_creation_input_tokens : 0) +
          (typeof u.cache_read_input_tokens === 'number' ? u.cache_read_input_tokens : 0)
        if (inp > 0) {
          inputTokens = inp
        }
        if (typeof u.output_tokens === 'number') {
          outputTokens = u.output_tokens
        }
      }
      return
    }
    if (type === 'message_stop') {
      sawStop = true
    }
  }

  const push = (chunk: Buffer | string) => {
    buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
    const lines = buffer.split(/\r?\n/)
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      if (line.startsWith('data:')) {
        const data = line.slice(5).trim()
        if (data !== '') {
          consumeData(data)
        }
      }
    }
  }

  const finish = () => {
    if (buffer.startsWith('data:')) {
      const data = buffer.slice(5).trim()
      if (data !== '') {
        consumeData(data)
      }
    }
    buffer = ''
    return {
      assistantContent,
      assistantThinking,
      stopReason,
      inputTokens,
      outputTokens,
      errorMessage,
      sawStop,
    }
  }

  return { push, finish }
}

export const chatProxyRoutes: FastifyPluginAsync<ChatProxyOptions> = async (
  app,
  { config, quota, policy, guestLogs }
) => {
  const proxy = config.chatProxy
  /** 按用户统计在途请求：一个人多设备同时开会话时不会把上游配额打满 */
  const inFlight = new Map<string, number>()

  const acquireSlot = (userId: string): void => {
    inFlight.set(userId, (inFlight.get(userId) ?? 0) + 1)
  }

  const releaseSlot = (userId: string): void => {
    const current = inFlight.get(userId) ?? 0
    if (current <= 1) {
      inFlight.delete(userId)
      return
    }
    inFlight.set(userId, current - 1)
  }

  const corsHeadersFor = (request: FastifyRequest): Record<string, string> => {
    const origin = request.headers.origin
    if (typeof origin !== 'string' || !config.corsOrigins.includes(origin)) {
      return {}
    }
    return {
      'access-control-allow-origin': origin,
      'access-control-allow-credentials': 'true',
      'access-control-expose-headers': 'retry-after',
      vary: 'Origin',
    }
  }

  const forward = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const userId = request.authUser?.id
    const guestIp = request.guestIp
    if (!userId && guestIp === undefined) {
      throw unauthorized()
    }
    if (!proxy.enabled || proxy.apiKey === null) {
      throw new HttpError(503, 'proxy_disabled', '服务端未配置上游 API Key，聊天代理不可用')
    }

    const trailing = (request.params as { '*'?: string })['*'] ?? ''
    const allowed = proxy.allowedPrefixes.some(
      (prefix) => trailing === prefix || trailing.startsWith(prefix)
    )
    if (!allowed) {
      throw forbidden('path_not_allowed', '不支持的代理路径')
    }

    // 访客对话：校验附件/搜索/思考权限并构造日志捕获上下文
    let forwardBody: unknown = request.body
    let guestCapture: GuestCaptureMeta | null = null
    if (
      !userId &&
      guestIp !== undefined &&
      request.method === 'POST' &&
      GUEST_COUNTED_PATHS.some((path) => matchesPath(trailing, path)) &&
      isRecord(request.body)
    ) {
      const currentPolicy = policy.get()
      const payload: Record<string, unknown> = { ...request.body }
      const rawFiles = parseGuestFilesHeader(request.headers['x-guest-files'])
      if (!currentPolicy.allowAttachments && (hasAttachmentBlocks(payload.messages) || rawFiles.length > 0)) {
        throw forbidden('guest_attachments_disabled', '免登录暂不支持上传附件，请登录后使用')
      }

      if (!currentPolicy.allowThinking) {
        payload.thinking = { type: 'disabled' }
      }
      if (!currentPolicy.allowSearch && Array.isArray(payload.tools)) {
        payload.tools = payload.tools.filter(
          (tool) => !(isRecord(tool) && tool.type === 'deepseek_web_search')
        )
      }
      forwardBody = payload

      const extracted = extractLastUserText(payload.messages)
      const rawSessionId = request.headers['x-guest-session-id']
      const sessionId =
        typeof rawSessionId === 'string' && rawSessionId.trim() !== ''
          ? rawSessionId.trim().slice(0, 80)
          : `guest-${guestIp}-${dayKeyOf(Date.now())}`
      const attachments =
        rawFiles.length > 0
          ? rawFiles
          : extracted.fileCount > 0
            ? Array.from({ length: extracted.fileCount }, (_, i) => `附件 #${i + 1}`)
            : []
      const thinkingEnabled =
        isRecord(payload.thinking) && payload.thinking.type === 'enabled'
      const searchEnabled =
        Array.isArray(payload.tools) &&
        payload.tools.some((tool) => isRecord(tool) && tool.type === 'deepseek_web_search')
      const agent = request.headers['user-agent']
      guestCapture = {
        id: randomUUID(),
        ip: guestIp,
        sessionId,
        userAgent: typeof agent === 'string' ? agent : null,
        model: typeof payload.model === 'string' ? payload.model : 'deepseek-flash',
        thinking: thinkingEnabled,
        search: searchEnabled,
        attachments,
        userContent: extracted.text,
        createdAt: Date.now(),
      }
    }

    const slotKey = userId ?? `guest:${guestIp ?? ''}`
    if ((inFlight.get(slotKey) ?? 0) >= proxy.maxConcurrentPerUser) {
      throw new HttpError(429, 'too_many_requests', '同时进行的请求过多，请稍后再试')
    }
    acquireSlot(slotKey)

    const rawUrl = request.raw.url ?? ''
    const queryIndex = rawUrl.indexOf('?')
    const search = queryIndex === -1 ? '' : rawUrl.slice(queryIndex)
    const target = new URL(`${proxy.origin}/${trailing}${search}`)

    const headers: Record<string, string | string[]> = {}
    for (const [key, value] of Object.entries(request.headers)) {
      const name = key.toLowerCase()
      if (value === undefined || HOP_BY_HOP.has(name) || CLIENT_ONLY.has(name)) {
        continue
      }
      headers[name] = value as string | string[]
    }
    headers['x-api-key'] = proxy.apiKey
    headers['x-forwarded-for'] = request.ip
    headers['x-forwarded-proto'] = request.protocol

    const send = target.protocol === 'https:' ? httpsRequest : httpRequest
    const sseCollector = guestCapture ? createGuestSseCollector() : null
    let nonSseErrorBody = ''
    let upstreamStatus = 200
    let logSaved = false

    const persistGuestLog = (
      status: 'done' | 'stopped' | 'error',
      explicitError?: string
    ): void => {
      if (!guestCapture || !sseCollector || logSaved) {
        return
      }
      logSaved = true
      try {
        const collected = sseCollector.finish()
        const finalError =
          explicitError ??
          collected.errorMessage ??
          (upstreamStatus >= 400 ? nonSseErrorBody.slice(0, 800) || `HTTP ${upstreamStatus}` : null)
        const finalStatus: 'done' | 'stopped' | 'error' =
          finalError !== null
            ? 'error'
            : status === 'stopped' && !collected.sawStop
              ? 'stopped'
              : 'done'
        guestLogs.record({
          ...guestCapture,
          assistantContent: collected.assistantContent,
          assistantThinking: collected.assistantThinking,
          status: finalStatus,
          stopReason: collected.stopReason,
          inputTokens: collected.inputTokens,
          outputTokens: collected.outputTokens,
          errorMessage: finalError,
          finishedAt: Date.now(),
        })
      } catch (error) {
        request.log.warn({ err: error }, '记录访客会话日志失败')
      }
    }

    await new Promise<void>((resolve) => {
      let settled = false
      const settle = () => {
        if (settled) {
          return
        }
        settled = true
        releaseSlot(slotKey)
        resolve()
      }

      const upstream = send(
        {
          protocol: target.protocol,
          hostname: target.hostname,
          port: target.port === '' ? undefined : Number(target.port),
          path: `${target.pathname}${target.search}`,
          method: request.method,
          headers,
        },
        (upstreamResponse) => {
          reply.hijack()
          upstreamStatus = upstreamResponse.statusCode ?? 502
          const responseHeaders: Record<string, string | string[]> = {}
          for (const [key, value] of Object.entries(upstreamResponse.headers)) {
            const name = key.toLowerCase()
            if (value === undefined || HOP_BY_HOP.has(name) || name === 'set-cookie') {
              continue
            }
            responseHeaders[name] = value as string | string[]
          }
          responseHeaders['x-accel-buffering'] = 'no'
          for (const [name, value] of Object.entries(guestQuotaHeaders(request))) {
            responseHeaders[name] = value
          }
          Object.assign(responseHeaders, corsHeadersFor(request))
          reply.raw.writeHead(upstreamStatus, responseHeaders)

          if (sseCollector) {
            const ct = String(upstreamResponse.headers['content-type'] ?? '')
            const isSse = ct.includes('text/event-stream')
            upstreamResponse.on('data', (chunk: Buffer) => {
              if (isSse) {
                sseCollector.push(chunk)
              } else if (nonSseErrorBody.length < 2000) {
                nonSseErrorBody += chunk.toString('utf8')
              }
            })
          }

          upstreamResponse.on('error', (err) => {
            persistGuestLog('error', err.message)
            reply.raw.destroy()
          })
          upstreamResponse.on('end', () => {
            persistGuestLog(upstreamStatus >= 400 ? 'error' : 'done')
            settle()
          })
          upstreamResponse.pipe(reply.raw)
          reply.raw.on('finish', () => {
            persistGuestLog(upstreamStatus >= 400 ? 'error' : 'done')
            settle()
          })
          reply.raw.on('close', () => {
            persistGuestLog('stopped')
            upstreamResponse.destroy()
            settle()
          })
        }
      )

      upstream.setTimeout(UPSTREAM_TIMEOUT_MS, () => upstream.destroy(new Error('upstream timeout')))

      upstream.on('error', (error: Error) => {
        persistGuestLog('error', error.message)
        if (reply.raw.headersSent || reply.raw.writableEnded) {
          reply.raw.destroy()
          settle()
          return
        }
        reply
          .code(502)
          .header('content-type', 'application/json; charset=utf-8')
          .send({
            error: { code: 'upstream_unavailable', message: `上游服务不可用：${error.message}` },
          })
        settle()
      })

      reply.raw.on('close', () => {
        persistGuestLog('stopped')
        if (!upstream.destroyed) {
          upstream.destroy()
        }
        settle()
      })

      const body = forwardBody
      if (body !== null && typeof body === 'object' && 'pipe' in body) {
        let received = 0
        const limiter = new Transform({
          transform(chunk: Buffer, _encoding, callback) {
            received += chunk.length
            if (received > proxy.maxBodyBytes) {
              callback(payloadTooLarge('请求体超过大小限制'))
              return
            }
            callback(null, chunk)
          },
        })
        limiter.on('error', () => upstream.destroy())
        ;(body as NodeJS.ReadableStream).pipe(limiter).pipe(upstream)
        return
      }

      if (body === undefined || body === null) {
        upstream.end()
        return
      }
      upstream.end(typeof body === 'string' ? body : JSON.stringify(body))
    })
  }

  /**
   * 网关准入：登录用户走完整鉴权且不受访客限制；未登录按实时策略与 IP 规则校验。
   */
  const authorize = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const presented =
      request.headers.authorization !== undefined ||
      request.cookies?.[config.cookieName] !== undefined
    if (presented) {
      await app.authenticate(request, reply)
      return
    }
    const currentPolicy = policy.get()
    if (!currentPolicy.enabled) {
      throw new HttpError(401, 'guest_disabled', '管理员已关闭免登录免费对话，请登录后使用')
    }
    const ipRule = policy.getIpRule(request.ip)
    if (ipRule?.blocked) {
      throw forbidden('guest_ip_blocked', '当前 IP 已被限制使用免费对话，请登录后使用')
    }
    const trailing = (request.params as { '*'?: string })['*'] ?? ''
    if (!GUEST_PATHS.some((path) => matchesPath(trailing, path))) {
      throw forbidden('guest_not_allowed', '访客只能使用对话功能，登录后可使用全部能力')
    }
    if (!currentPolicy.allowAttachments && matchesPath(trailing, 'anthropic/v1/files')) {
      throw forbidden('guest_attachments_disabled', '免登录暂不支持上传附件，请登录后使用')
    }
    if (
      request.method === 'POST' &&
      GUEST_COUNTED_PATHS.some((path) => matchesPath(trailing, path))
    ) {
      // 若包含被禁止的附件块，先拦下再扣额度，避免白白扣次数
      if (!currentPolicy.allowAttachments && isRecord(request.body) && hasAttachmentBlocks(request.body.messages)) {
        throw forbidden('guest_attachments_disabled', '免登录暂不支持上传附件，请登录后使用')
      }
      const decision = quota.consume(request.ip, Date.now())
      request.guestQuota = decision
      for (const [name, value] of Object.entries(guestQuotaHeaders(request))) {
        reply.header(name, value)
      }
      if (!decision.allowed) {
        throw new HttpError(
          429,
          'guest_quota_exhausted',
          `今日免费对话次数已用完（每天 ${decision.limit} 次），登录后可继续使用`,
          { retryAfterMs: decision.resetAt - Date.now() }
        )
      }
    }
    request.guestIp = request.ip
    reply.header('cache-control', 'no-store')
  }

  app.all('/api/gateway/*', { preHandler: authorize }, forward)
}
