import { BACKEND_ORIGIN, getSessionToken, setSessionToken, usesBearerToken } from './session.js'

export type AuthUser = {
  id: string
  username: string
  status: string
  createdAt: number
  avatar?: string | null
}

export type AuthSessionInfo = {
  sessionId: string
  expiresAt: number
  token?: string
}

/** 后端返回的错误统一是 { error: { code, message } } */
export class AuthError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number
  ) {
    super(message)
    this.name = 'AuthError'
  }
}

const authRequest = async <T>(path: string, init: RequestInit = {}): Promise<T> => {
  const headers = new Headers(init.headers)
  headers.set('content-type', 'application/json')
  headers.set('x-session-mode', usesBearerToken() ? 'bearer' : 'cookie')
  const token = getSessionToken()
  if (token) {
    headers.set('authorization', `Bearer ${token}`)
  }

  let response: Response
  try {
    response = await fetch(`${BACKEND_ORIGIN}/api/auth${path}`, {
      ...init,
      headers,
      credentials: 'include',
    })
  } catch {
    throw new AuthError('network', '网络错误', 0)
  }

  if (response.status === 204) {
    return undefined as T
  }
  const text = await response.text()
  let body: unknown = null
  if (text !== '') {
    try {
      body = JSON.parse(text)
    } catch {
      body = null
    }
  }
  if (!response.ok) {
    const error = (body as { error?: { code?: string; message?: string } } | null)?.error
    throw new AuthError(
      error?.code ?? 'unknown',
      error?.message ?? `请求失败（${response.status}）`,
      response.status
    )
  }
  return body as T
}

const rememberSession = (session: AuthSessionInfo | undefined): void => {
  // 只有在显式要求 Bearer 时服务端才会返回令牌
  if (session?.token) {
    setSessionToken(session.token)
  }
}

export const authLogin = async (
  username: string,
  password: string
): Promise<{ user: AuthUser; session: AuthSessionInfo }> => {
  const result = await authRequest<{ user: AuthUser; session: AuthSessionInfo }>('/login', {
    method: 'POST',
    body: JSON.stringify({ username, password }),
  })
  rememberSession(result.session)
  return result
}

export const authMe = async (): Promise<{ user: AuthUser }> =>
  await authRequest<{ user: AuthUser }>('/me')

export const authLogout = async (): Promise<void> => {
  try {
    await authRequest<undefined>('/logout', { method: 'POST' })
  } finally {
    setSessionToken(null)
  }
}

export const authRevokeOtherSessions = async (): Promise<number> => {
  const result = await authRequest<{ revoked: number }>('/sessions', { method: 'DELETE' })
  return result.revoked
}

export const authUpdateAvatar = async (avatar: string | null): Promise<{ user: AuthUser }> =>
  await authRequest<{ user: AuthUser }>('/avatar', {
    method: 'PUT',
    body: JSON.stringify({ avatar }),
  })
