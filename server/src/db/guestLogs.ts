import type { Database } from './types.js'
import { dayKeyOf } from './guestQuota.js'

const DAY_MS = 24 * 60 * 60 * 1000
/** 免登录会话日志默认保留 90 天 */
const LOG_RETENTION_DAYS = 90
const MAX_STORED_TEXT = 120_000

export type GuestLogRecord = {
  id: string
  day: string
  ip: string
  sessionId: string
  userAgent: string | null
  model: string
  thinking: boolean
  search: boolean
  attachments: string[]
  userContent: string
  assistantContent: string
  assistantThinking: string
  status: 'done' | 'stopped' | 'error'
  stopReason: string | null
  inputTokens: number | null
  outputTokens: number | null
  errorMessage: string | null
  createdAt: number
  finishedAt: number | null
}

export type GuestLogInput = Omit<GuestLogRecord, 'day'>

export type GuestVisitorSummary = {
  ip: string
  totalMessages: number
  sessionCount: number
  lastActiveAt: number
  lastUserAgent: string | null
  lastQuestion: string
}

type GuestLogRow = {
  id: string
  day: string
  ip: string
  session_id: string
  user_agent: string | null
  model: string
  thinking: number
  search: number
  attachments: string
  user_content: string
  assistant_content: string
  assistant_thinking: string
  status: string
  stop_reason: string | null
  input_tokens: number | null
  output_tokens: number | null
  error_message: string | null
  created_at: number
  finished_at: number | null
}

const parseAttachments = (raw: string): string[] => {
  try {
    const parsed = JSON.parse(raw) as unknown
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string')
      : []
  } catch {
    return []
  }
}

const toRecord = (row: GuestLogRow): GuestLogRecord => ({
  id: row.id,
  day: row.day,
  ip: row.ip,
  sessionId: row.session_id,
  userAgent: row.user_agent,
  model: row.model,
  thinking: row.thinking !== 0,
  search: row.search !== 0,
  attachments: parseAttachments(row.attachments),
  userContent: row.user_content,
  assistantContent: row.assistant_content,
  assistantThinking: row.assistant_thinking,
  status:
    row.status === 'stopped' || row.status === 'error' ? row.status : 'done',
  stopReason: row.stop_reason,
  inputTokens: row.input_tokens,
  outputTokens: row.output_tokens,
  errorMessage: row.error_message,
  createdAt: row.created_at,
  finishedAt: row.finished_at,
})

const clampText = (value: string): string =>
  value.length > MAX_STORED_TEXT ? `${value.slice(0, MAX_STORED_TEXT)}…` : value

const escapeLike = (keyword: string): string =>
  keyword.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_')

/**
 * 免登录访客会话日志仓库：
 * 由服务端网关在转发访客对话时自动落库，完整保存 IP、提问、附件、开关、AI 回复与 Token 用量。
 */
export const createGuestLogRepo = (db: Database) => {
  const insertStmt = db.prepare(
    `INSERT OR REPLACE INTO guest_logs (
       id, day, ip, session_id, user_agent, model, thinking, search, attachments,
       user_content, assistant_content, assistant_thinking, status, stop_reason,
       input_tokens, output_tokens, error_message, created_at, finished_at
     ) VALUES (
       @id, @day, @ip, @sessionId, @userAgent, @model, @thinking, @search, @attachments,
       @userContent, @assistantContent, @assistantThinking, @status, @stopReason,
       @inputTokens, @outputTokens, @errorMessage, @createdAt, @finishedAt
     )`
  )

  const getByIdStmt = db.prepare<[string], GuestLogRow>('SELECT * FROM guest_logs WHERE id = ?')
  const deleteByIdStmt = db.prepare<[string]>('DELETE FROM guest_logs WHERE id = ?')
  const deleteByIpStmt = db.prepare<[string]>('DELETE FROM guest_logs WHERE ip = ?')
  const deleteAllStmt = db.prepare('DELETE FROM guest_logs')
  const pruneStmt = db.prepare<[number]>('DELETE FROM guest_logs WHERE created_at < ?')

  const totalStatsStmt = db.prepare<
    [],
    {
      totalMessages: number
      totalIps: number
      totalSessions: number
      totalInputTokens: number
      totalOutputTokens: number
    }
  >(
    `SELECT
       COUNT(*) AS totalMessages,
       COUNT(DISTINCT ip) AS totalIps,
       COUNT(DISTINCT session_id) AS totalSessions,
       COALESCE(SUM(input_tokens), 0) AS totalInputTokens,
       COALESCE(SUM(output_tokens), 0) AS totalOutputTokens
     FROM guest_logs`
  )

  const todayStatsStmt = db.prepare<[string], { todayMessages: number; todayIps: number }>(
    `SELECT COUNT(*) AS todayMessages, COUNT(DISTINCT ip) AS todayIps
     FROM guest_logs WHERE day = ?`
  )

  const aggregateByIpStmt = db.prepare<
    [],
    {
      ip: string
      total_messages: number
      session_count: number
      last_active_at: number
    }
  >(
    `SELECT
       ip,
       COUNT(*) AS total_messages,
       COUNT(DISTINCT session_id) AS session_count,
       MAX(created_at) AS last_active_at
     FROM guest_logs
     GROUP BY ip
     ORDER BY last_active_at DESC`
  )

  const latestByIpStmt = db.prepare<
    [string],
    { user_agent: string | null; user_content: string }
  >(
    `SELECT user_agent, user_content FROM guest_logs WHERE ip = ? ORDER BY created_at DESC LIMIT 1`
  )

  return {
    record(input: GuestLogInput): void {
      insertStmt.run({
        id: input.id,
        day: dayKeyOf(input.createdAt),
        ip: input.ip,
        sessionId: input.sessionId,
        userAgent: input.userAgent ? input.userAgent.slice(0, 255) : null,
        model: input.model,
        thinking: input.thinking ? 1 : 0,
        search: input.search ? 1 : 0,
        attachments: JSON.stringify(input.attachments.slice(0, 50)),
        userContent: clampText(input.userContent),
        assistantContent: clampText(input.assistantContent),
        assistantThinking: clampText(input.assistantThinking),
        status: input.status,
        stopReason: input.stopReason,
        inputTokens: input.inputTokens,
        outputTokens: input.outputTokens,
        errorMessage: input.errorMessage ? input.errorMessage.slice(0, 1000) : null,
        createdAt: input.createdAt,
        finishedAt: input.finishedAt,
      })
    },

    get(id: string): GuestLogRecord | null {
      const row = getByIdStmt.get(id)
      return row ? toRecord(row) : null
    },

    list(options: {
      ip?: string
      sessionId?: string
      search?: string
      offset?: number
      limit?: number
    }): { items: GuestLogRecord[]; total: number } {
      const where: string[] = []
      const params: unknown[] = []
      if (options.ip && options.ip.trim() !== '') {
        where.push('ip = ?')
        params.push(options.ip.trim())
      }
      if (options.sessionId && options.sessionId.trim() !== '') {
        where.push('session_id = ?')
        params.push(options.sessionId.trim())
      }
      if (options.search && options.search.trim() !== '') {
        const pattern = `%${escapeLike(options.search.trim())}%`
        where.push(
          `(ip LIKE ? ESCAPE '\\' OR user_content LIKE ? ESCAPE '\\' OR assistant_content LIKE ? ESCAPE '\\' OR attachments LIKE ? ESCAPE '\\')`
        )
        params.push(pattern, pattern, pattern, pattern)
      }
      const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''
      const limit = Math.min(100, Math.max(1, Math.floor(options.limit ?? 30)))
      const offset = Math.max(0, Math.floor(options.offset ?? 0))

      const countRow = db
        .prepare(`SELECT COUNT(*) AS cnt FROM guest_logs ${whereSql}`)
        .get(...params) as { cnt: number }
      const order = options.sessionId ? 'ORDER BY created_at ASC' : 'ORDER BY created_at DESC'
      const rows = db
        .prepare(`SELECT * FROM guest_logs ${whereSql} ${order} LIMIT ? OFFSET ?`)
        .all(...params, limit, offset) as GuestLogRow[]

      return { items: rows.map(toRecord), total: countRow?.cnt ?? 0 }
    },

    listVisitorStats(): GuestVisitorSummary[] {
      const grouped = aggregateByIpStmt.all()
      return grouped.map((row) => {
        const latest = latestByIpStmt.get(row.ip)
        return {
          ip: row.ip,
          totalMessages: row.total_messages,
          sessionCount: row.session_count,
          lastActiveAt: row.last_active_at,
          lastUserAgent: latest?.user_agent ?? null,
          lastQuestion: (latest?.user_content ?? '').slice(0, 160),
        }
      })
    },

    stats(at: number) {
      const totals = totalStatsStmt.get() ?? {
        totalMessages: 0,
        totalIps: 0,
        totalSessions: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
      }
      const today = todayStatsStmt.get(dayKeyOf(at)) ?? { todayMessages: 0, todayIps: 0 }
      return { ...totals, ...today }
    },

    remove(id: string): boolean {
      return deleteByIdStmt.run(id).changes > 0
    },

    removeByIp(ip: string): number {
      return deleteByIpStmt.run(ip).changes
    },

    clearAll(): number {
      return deleteAllStmt.run().changes
    },

    prune(at: number): number {
      return pruneStmt.run(at - LOG_RETENTION_DAYS * DAY_MS).changes
    },
  }
}

export type GuestLogRepo = ReturnType<typeof createGuestLogRepo>
