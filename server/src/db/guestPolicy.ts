import type { Database } from './types.js'

export type GuestPolicy = {
  /** 是否允许免登录免费对话 */
  enabled: boolean
  /** 默认每日免费对话次数上限 */
  dailyMessages: number
  /** 是否允许免登录上传附件（含图片、文档、表格） */
  allowAttachments: boolean
  /** 是否允许免登录使用联网搜索 */
  allowSearch: boolean
  /** 是否允许免登录开启深度思考 */
  allowThinking: boolean
  updatedAt: number
}

export type GuestPolicyPatch = Partial<Omit<GuestPolicy, 'updatedAt'>>

export type GuestIpRule = {
  ip: string
  /** 为 null 表示沿用全局默认每日次数 */
  dailyLimit: number | null
  blocked: boolean
  note: string
  updatedAt: number
}

type SettingRow = { key: string; value: string; updated_at: number }
type IpRuleRow = {
  ip: string
  daily_limit: number | null
  blocked: number
  note: string
  updated_at: number
}

const KEYS = {
  enabled: 'guest_enabled',
  dailyMessages: 'guest_daily_messages',
  allowAttachments: 'guest_allow_attachments',
  allowSearch: 'guest_allow_search',
  allowThinking: 'guest_allow_thinking',
} as const

const parseBool = (raw: string | undefined, fallback: boolean): boolean => {
  if (raw === undefined) {
    return fallback
  }
  return raw === 'true' || raw === '1'
}

const parseIntSafe = (raw: string | undefined, fallback: number): number => {
  if (raw === undefined) {
    return fallback
  }
  const n = Number(raw)
  return Number.isInteger(n) && n >= 0 ? n : fallback
}

const toIpRule = (row: IpRuleRow): GuestIpRule => ({
  ip: row.ip,
  dailyLimit: row.daily_limit,
  blocked: row.blocked !== 0,
  note: row.note,
  updatedAt: row.updated_at,
})

/**
 * 访客策略与 IP 规则仓库：
 * 初始默认值由 .env 的 GUEST_DAILY_MESSAGES 推导；
 * 管理员在后台修改后立即写入 SQLite，无需重启服务，重启后持续生效。
 */
export const createGuestPolicyRepo = (db: Database, defaultDailyMessages: number) => {
  const defaults = {
    enabled: defaultDailyMessages > 0,
    dailyMessages: defaultDailyMessages > 0 ? defaultDailyMessages : 10,
    allowAttachments: true,
    allowSearch: true,
    allowThinking: true,
  }

  const selectAllSettings = db.prepare<[], SettingRow>(
    'SELECT key, value, updated_at FROM app_settings'
  )
  const upsertSetting = db.prepare<{ key: string; value: string; at: number }>(
    `INSERT INTO app_settings (key, value, updated_at)
     VALUES (@key, @value, @at)
     ON CONFLICT(key) DO UPDATE SET value = @value, updated_at = @at`
  )

  const selectIpRule = db.prepare<[string], IpRuleRow>(
    'SELECT ip, daily_limit, blocked, note, updated_at FROM guest_ip_rules WHERE ip = ?'
  )
  const listAllIpRules = db.prepare<[], IpRuleRow>(
    'SELECT ip, daily_limit, blocked, note, updated_at FROM guest_ip_rules ORDER BY updated_at DESC'
  )
  const upsertIpRule = db.prepare<{
    ip: string
    dailyLimit: number | null
    blocked: number
    note: string
    at: number
  }>(
    `INSERT INTO guest_ip_rules (ip, daily_limit, blocked, note, updated_at)
     VALUES (@ip, @dailyLimit, @blocked, @note, @at)
     ON CONFLICT(ip) DO UPDATE SET
       daily_limit = @dailyLimit,
       blocked = @blocked,
       note = @note,
       updated_at = @at`
  )
  const deleteIpRule = db.prepare<[string]>('DELETE FROM guest_ip_rules WHERE ip = ?')

  const get = (): GuestPolicy => {
    const rows = selectAllSettings.all()
    const map = new Map<string, SettingRow>(rows.map((r) => [r.key, r]))
    let updatedAt = 0
    for (const row of rows) {
      if (row.updated_at > updatedAt) {
        updatedAt = row.updated_at
      }
    }
    return {
      enabled: parseBool(map.get(KEYS.enabled)?.value, defaults.enabled),
      dailyMessages: parseIntSafe(map.get(KEYS.dailyMessages)?.value, defaults.dailyMessages),
      allowAttachments: parseBool(map.get(KEYS.allowAttachments)?.value, defaults.allowAttachments),
      allowSearch: parseBool(map.get(KEYS.allowSearch)?.value, defaults.allowSearch),
      allowThinking: parseBool(map.get(KEYS.allowThinking)?.value, defaults.allowThinking),
      updatedAt,
    }
  }

  const update = (patch: GuestPolicyPatch, at = Date.now()): GuestPolicy => {
    const run = db.transaction(() => {
      if (patch.enabled !== undefined) {
        upsertSetting.run({ key: KEYS.enabled, value: String(patch.enabled), at })
      }
      if (patch.dailyMessages !== undefined) {
        upsertSetting.run({
          key: KEYS.dailyMessages,
          value: String(Math.max(0, Math.min(10000, Math.floor(patch.dailyMessages)))),
          at,
        })
      }
      if (patch.allowAttachments !== undefined) {
        upsertSetting.run({
          key: KEYS.allowAttachments,
          value: String(patch.allowAttachments),
          at,
        })
      }
      if (patch.allowSearch !== undefined) {
        upsertSetting.run({ key: KEYS.allowSearch, value: String(patch.allowSearch), at })
      }
      if (patch.allowThinking !== undefined) {
        upsertSetting.run({ key: KEYS.allowThinking, value: String(patch.allowThinking), at })
      }
    })
    run()
    return get()
  }

  const getIpRule = (ip: string): GuestIpRule | null => {
    const row = selectIpRule.get(ip)
    return row ? toIpRule(row) : null
  }

  const setIpRule = (
    ip: string,
    input: { dailyLimit?: number | null; blocked?: boolean; note?: string },
    at = Date.now()
  ): GuestIpRule => {
    const existing = getIpRule(ip)
    const dailyLimit =
      input.dailyLimit === undefined
        ? (existing?.dailyLimit ?? null)
        : input.dailyLimit === null
          ? null
          : Math.max(0, Math.min(10000, Math.floor(input.dailyLimit)))
    const blocked = input.blocked === undefined ? (existing?.blocked ?? false) : input.blocked
    const note =
      input.note === undefined ? (existing?.note ?? '') : input.note.trim().slice(0, 200)

    if (dailyLimit === null && !blocked && note === '') {
      deleteIpRule.run(ip)
      return { ip, dailyLimit: null, blocked: false, note: '', updatedAt: at }
    }
    upsertIpRule.run({ ip, dailyLimit, blocked: blocked ? 1 : 0, note, at })
    return { ip, dailyLimit, blocked, note, updatedAt: at }
  }

  const effectiveLimitFor = (ip: string): number => {
    const policy = get()
    if (!policy.enabled) {
      return 0
    }
    const rule = getIpRule(ip)
    if (rule?.blocked) {
      return 0
    }
    return rule?.dailyLimit ?? policy.dailyMessages
  }

  return {
    get,
    update,
    getIpRule,
    listIpRules: (): GuestIpRule[] => listAllIpRules.all().map(toIpRule),
    setIpRule,
    removeIpRule: (ip: string): void => {
      deleteIpRule.run(ip)
    },
    effectiveLimitFor,
  }
}

export type GuestPolicyRepo = ReturnType<typeof createGuestPolicyRepo>
