import {
  BACKEND_ORIGIN,
  getSessionToken,
  notifyUnauthorized,
  usesBearerToken,
} from './auth/session.js'

export type AdminGuestPolicy = {
  enabled: boolean
  dailyMessages: number
  allowAttachments: boolean
  allowSearch: boolean
  allowThinking: boolean
  updatedAt: number
}

export type AdminOverviewStats = {
  todayMessages: number
  todayIps: number
  totalMessages: number
  totalIps: number
  totalSessions: number
  totalInputTokens: number
  totalOutputTokens: number
}

export type AdminOverview = {
  policy: AdminGuestPolicy
  stats: AdminOverviewStats
}

export type AdminVisitor = {
  ip: string
  todayUsed: number
  effectiveLimit: number
  customLimit: number | null
  blocked: boolean
  note: string
  totalMessages: number
  sessionCount: number
  lastActiveAt: number
  lastUserAgent: string | null
  lastQuestion: string
}

export type AdminGuestLog = {
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

const request = async <T>(path: string, init: RequestInit = {}): Promise<T> => {
  const headers = new Headers(init.headers)
  headers.set('x-session-mode', usesBearerToken() ? 'bearer' : 'cookie')
  const token = getSessionToken()
  if (token) {
    headers.set('authorization', `Bearer ${token}`)
  }
  const response = await fetch(`${BACKEND_ORIGIN}/api/admin${path}`, {
    ...init,
    headers,
    credentials: 'include',
  })
  if (response.status === 401) {
    notifyUnauthorized()
    throw new Error('unauthorized')
  }
  if (response.status === 204) {
    return undefined as T
  }
  const text = await response.text().catch(() => '')
  const parsed = text ? (JSON.parse(text) as unknown) : null
  if (!response.ok) {
    const msg =
      (parsed as { error?: { message?: string } } | null)?.error?.message ??
      `HTTP ${response.status}`
    throw new Error(msg)
  }
  return parsed as T
}

export const fetchAdminOverview = () => request<AdminOverview>('/overview')

export const updateAdminPolicy = (
  patch: Partial<Omit<AdminGuestPolicy, 'updatedAt'>>
): Promise<{ policy: AdminGuestPolicy }> =>
  request<{ policy: AdminGuestPolicy }>('/policy', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  })

export const fetchAdminVisitors = (search = '') => {
  const qs = search.trim() ? `?search=${encodeURIComponent(search.trim())}` : ''
  return request<{ visitors: AdminVisitor[]; policy: AdminGuestPolicy }>(`/visitors${qs}`)
}

export const updateAdminVisitorRule = (
  ip: string,
  patch: { dailyLimit?: number | null; blocked?: boolean; note?: string }
) =>
  request(`/visitors/${encodeURIComponent(ip)}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  })

export const resetAdminVisitorQuota = (ip: string) =>
  request(`/visitors/${encodeURIComponent(ip)}/reset`, { method: 'POST' })

export const fetchAdminLogs = (params: {
  ip?: string
  sessionId?: string
  search?: string
  offset?: number
  limit?: number
}) => {
  const query = new URLSearchParams()
  if (params.ip) {
    query.set('ip', params.ip)
  }
  if (params.sessionId) {
    query.set('sessionId', params.sessionId)
  }
  if (params.search) {
    query.set('search', params.search)
  }
  if (params.offset !== undefined) {
    query.set('offset', String(params.offset))
  }
  if (params.limit !== undefined) {
    query.set('limit', String(params.limit))
  }
  const qs = query.toString()
  return request<{ items: AdminGuestLog[]; total: number }>(`/logs${qs ? `?${qs}` : ''}`)
}

export const deleteAdminLog = async (id: string): Promise<void> => {
  await request<undefined>(`/logs/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

export const clearAdminLogs = () =>
  request<{ deleted: number }>('/logs', { method: 'DELETE' })
