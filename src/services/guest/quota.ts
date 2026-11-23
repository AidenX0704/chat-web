import { create } from 'zustand'
import { BACKEND_ORIGIN, isGuestMode, usesBearerToken, getSessionToken } from '../auth/session.js'

/** 未登录访客当天的对话额度与可用能力，与服务端 /api/guest/quota 一一对应 */
export type GuestQuota = {
  /** 管理员是否开启免登录免费对话 */
  enabled: boolean
  /** 当前 IP 是否被管理员限制 */
  blocked: boolean
  /** 每天的总次数 */
  limit: number
  used: number
  remaining: number
  /** 额度重置时刻（下一天零点） */
  resetAt: number
  /** 是否允许上传附件 */
  allowAttachments: boolean
  /** 是否允许联网搜索 */
  allowSearch: boolean
  /** 是否允许深度思考 */
  allowThinking: boolean
}

type GuestQuotaState = {
  /** null 表示还没拿到（首次进入或请求失败） */
  quota: GuestQuota | null
}

export const useGuestQuota = create<GuestQuotaState>(() => ({ quota: null }))

const { setState } = useGuestQuota

const parseQuota = (value: unknown): GuestQuota | null => {
  const guest = (value as { guest?: unknown } | null)?.guest
  if (typeof guest !== 'object' || guest === null) {
    return null
  }
  const {
    limit,
    used,
    remaining,
    resetAt,
    enabled,
    blocked,
    allowAttachments,
    allowSearch,
    allowThinking,
  } = guest as Record<string, unknown>
  if (
    typeof limit !== 'number' ||
    typeof used !== 'number' ||
    typeof remaining !== 'number' ||
    typeof resetAt !== 'number'
  ) {
    return null
  }
  return {
    enabled: typeof enabled === 'boolean' ? enabled : limit > 0,
    blocked: typeof blocked === 'boolean' ? blocked : false,
    limit,
    used,
    remaining,
    resetAt,
    allowAttachments: typeof allowAttachments === 'boolean' ? allowAttachments : true,
    allowSearch: typeof allowSearch === 'boolean' ? allowSearch : true,
    allowThinking: typeof allowThinking === 'boolean' ? allowThinking : true,
  }
}

/**
 * 刷新访客额度与可用能力：进入访客界面时拉一次，每次对话结束后再拉一次。
 * 拿不到就保持上一次的值——真正的拦截在服务端，这里只影响提示与界面开关态。
 */
export const refreshGuestQuota = async (): Promise<void> => {
  if (!isGuestMode()) {
    setState({ quota: null })
    return
  }
  const headers = new Headers()
  headers.set('x-session-mode', usesBearerToken() ? 'bearer' : 'cookie')
  const token = getSessionToken()
  if (token) {
    headers.set('authorization', `Bearer ${token}`)
  }
  try {
    const response = await fetch(`${BACKEND_ORIGIN}/api/guest/quota`, {
      headers,
      credentials: 'include',
    })
    if (!response.ok) {
      return
    }
    const quota = parseQuota(await response.json())
    if (quota) {
      setState({ quota })
    }
  } catch {
    // 网络不通时不影响继续尝试对话，服务端会给出准确结果
  }
}

/** 访客当天的免费次数是否已经用完（登录用户永远返回 false） */
export const isGuestQuotaExhausted = (): boolean => {
  const { quota } = useGuestQuota.getState()
  return quota !== null && quota.remaining <= 0
}

export const isGuestDisabled = (): boolean => {
  const { quota } = useGuestQuota.getState()
  return quota !== null && !quota.enabled
}

export const isGuestIpBlocked = (): boolean => {
  const { quota } = useGuestQuota.getState()
  return quota !== null && quota.blocked
}

export const canGuestUseAttachments = (): boolean => {
  if (!isGuestMode()) {
    return true
  }
  const { quota } = useGuestQuota.getState()
  return quota === null || quota.allowAttachments
}

export const canGuestUseSearch = (): boolean => {
  if (!isGuestMode()) {
    return true
  }
  const { quota } = useGuestQuota.getState()
  return quota === null || quota.allowSearch
}

export const canGuestUseThinking = (): boolean => {
  if (!isGuestMode()) {
    return true
  }
  const { quota } = useGuestQuota.getState()
  return quota === null || quota.allowThinking
}
