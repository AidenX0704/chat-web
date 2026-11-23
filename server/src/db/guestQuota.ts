import type { Database } from './types.js'

/** 额度按服务器本地时区切天：和用户体感里的「今天」一致 */
const DAY_MS = 24 * 60 * 60 * 1000
/** 用量记录保留天数 */
const RETENTION_DAYS = 30

type GuestUsageRow = { messages: number }
type GuestDailyRow = { ip: string; messages: number; updated_at: number }

/** 某个 IP 当天的额度情况；remaining 为 0 时可以用 resetAt 算出还有多久重置 */
export type GuestQuotaSnapshot = {
  limit: number
  used: number
  remaining: number
  /** 额度重置时刻（下一天零点的毫秒时间戳） */
  resetAt: number
}

export type GuestQuotaDecision = GuestQuotaSnapshot & {
  /** 本次请求是否还能用 */
  allowed: boolean
}

export type GuestQuotaRepo = ReturnType<typeof createGuestQuotaRepo>

/** 本地时区的日期键，如 2026-11-20 */
export const dayKeyOf = (at: number): string => {
  const date = new Date(at)
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

const nextMidnight = (at: number): number => {
  const date = new Date(at)
  date.setHours(24, 0, 0, 0)
  return date.getTime()
}

/**
 * 访客额度：未登录用户凭 IP 每天可以发固定条数的对话请求。
 * 支持动态上限（由管理员策略与单 IP 覆盖规则实时决定）。
 */
export const createGuestQuotaRepo = (
  db: Database,
  limitSource: number | ((ip: string) => number)
) => {
  const resolveLimit = typeof limitSource === 'function' ? limitSource : () => limitSource

  const select = db.prepare<[string, string], GuestUsageRow>(
    'SELECT messages FROM guest_usage WHERE day = ? AND ip = ?'
  )
  const increase = db.prepare(
    `INSERT INTO guest_usage (day, ip, messages, updated_at)
     VALUES (@day, @ip, 1, @now)
     ON CONFLICT(day, ip) DO UPDATE SET
       messages = messages + 1,
       updated_at = @now
     WHERE messages < @limit`
  )
  const resetDayIp = db.prepare<[string, string]>(
    'DELETE FROM guest_usage WHERE day = ? AND ip = ?'
  )
  const selectDayAll = db.prepare<[string], GuestDailyRow>(
    'SELECT ip, messages, updated_at FROM guest_usage WHERE day = ? ORDER BY updated_at DESC'
  )
  const selectTodayTotals = db.prepare<[string], { total: number; ips: number }>(
    'SELECT COALESCE(SUM(messages), 0) AS total, COUNT(*) AS ips FROM guest_usage WHERE day = ?'
  )
  const pruneOld = db.prepare<[string]>('DELETE FROM guest_usage WHERE day < ?')

  const snapshot = (ip: string, at: number): GuestQuotaSnapshot => {
    const limit = Math.max(0, resolveLimit(ip))
    const used = select.get(dayKeyOf(at), ip)?.messages ?? 0
    return {
      limit,
      used,
      remaining: Math.max(0, limit - used),
      resetAt: nextMidnight(at),
    }
  }

  return {
    /** 只读当前额度，不消耗次数 */
    snapshot,
    /** 消耗一次额度；allowed 为 false 表示当天已经用完或上限为 0 */
    consume(ip: string, at: number): GuestQuotaDecision {
      const limit = Math.max(0, resolveLimit(ip))
      if (limit <= 0) {
        const current = snapshot(ip, at)
        return { ...current, allowed: false }
      }
      const inserted = increase.run({ day: dayKeyOf(at), ip, now: at, limit })
      const current = snapshot(ip, at)
      return { ...current, allowed: inserted.changes > 0 }
    },
    /** 管理员重置指定 IP 当天已用次数 */
    resetIp(ip: string, at: number): void {
      resetDayIp.run(dayKeyOf(at), ip)
    },
    /** 列出指定日期所有有过对话的访客 IP 计数 */
    listDay(at: number): GuestDailyRow[] {
      return selectDayAll.all(dayKeyOf(at))
    },
    /** 当天汇总（对话总数、独立 IP 数） */
    todayTotals(at: number): { total: number; ips: number } {
      return selectTodayTotals.get(dayKeyOf(at)) ?? { total: 0, ips: 0 }
    },
    prune(at: number): number {
      return pruneOld.run(dayKeyOf(at - RETENTION_DAYS * DAY_MS)).changes
    },
  }
}
