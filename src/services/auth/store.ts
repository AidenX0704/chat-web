import { create } from 'zustand'
import type { TranslationKey, TranslationMessage } from '../../i18n/index.js'
import {
  AuthError,
  authLogin,
  authLogout,
  authMe,
  authRevokeOtherSessions,
  authUpdateAvatar,
  type AuthUser,
} from './client.js'
import { isBackendMode, onUnauthorized, restoreSessionToken, setGuestMode } from './session.js'

export type AuthStatus = 'unknown' | 'anonymous' | 'authenticated'

type AuthState = {
  status: AuthStatus
  user: AuthUser | null
  /**
   * 访客界面点「登录」后展开登录页；关闭后回到访客对话。
   * 未登录也能先聊几句，所以默认不再直接把登录页怼在脸上。
   */
  loginPrompt: boolean
  busy: boolean
  /** 已有本地化文案的错误 */
  error: TranslationMessage | null
  /** 未收录的错误直接展示服务端原文 */
  errorText: string | null
}

/** 服务端错误码 → 界面文案 */
const ERROR_KEYS: Record<string, TranslationKey> = {
  unauthorized: 'loginInvalidCredentials',
  username_required: 'loginUsernameRequired',
  password_required: 'loginPasswordRequired',
  too_many_requests: 'loginTooManyAttempts',
  account_disabled: 'loginAccountDisabled',
  network: 'loginNetworkFailed',
  invalid_request: 'loginFailed',
}

/** 错误码不在表里时，用服务端文案兜底；有中文原文总比一片空白好 */
const toError = (
  error: unknown
): { error: TranslationMessage | null; errorText: string | null } => {
  if (error instanceof AuthError) {
    const key = ERROR_KEYS[error.code]
    if (key) {
      return { error: { key }, errorText: null }
    }
    return { error: null, errorText: error.message }
  }
  return { error: { key: 'loginFailed' }, errorText: null }
}

export const useAuth = create<AuthState>(() => ({
  status: 'unknown',
  user: null,
  loginPrompt: false,
  busy: false,
  error: null,
  errorText: null,
}))

const { getState: get, setState: set } = useAuth

/** 任意请求 401：登录态失效，退回访客并提示重新登录 */
onUnauthorized(() => {
  if (get().status === 'authenticated') {
    setGuestMode(true)
    set({
      status: 'anonymous',
      user: null,
      loginPrompt: true,
      error: { key: 'authExpired' },
      errorText: null,
    })
  }
})

export const initAuth = async (): Promise<void> => {
  if (!isBackendMode) {
    // 纯静态部署：没有登录概念，直接进入应用
    setGuestMode(false)
    set({ status: 'authenticated', user: null })
    return
  }
  restoreSessionToken()
  try {
    const { user } = await authMe()
    setGuestMode(false)
    set({ status: 'authenticated', user, error: null, errorText: null })
  } catch {
    // 没有登录态也可以先聊：按访客继续，会话存本机
    setGuestMode(true)
    set({ status: 'anonymous', user: null })
  }
}

/** 唯一账号登录：凭据由服务端 .env 决定，前端不提供注册入口 */
export const login = async (username: string, password: string): Promise<boolean> => {
  set({ busy: true, error: null, errorText: null })
  try {
    const { user } = await authLogin(username, password)
    setGuestMode(false)
    set({ busy: false, status: 'authenticated', user, loginPrompt: false })
    return true
  } catch (error) {
    set({ busy: false, ...toError(error) })
    return false
  }
}

export const logout = async (): Promise<void> => {
  try {
    await authLogout()
  } catch {
    // 网络失败也要回到登录页，本地令牌已经清掉
  }
  setGuestMode(true)
  set({ status: 'anonymous', user: null, loginPrompt: false, error: null, errorText: null })
}

export const revokeOtherSessions = async (): Promise<number | null> => {
  try {
    return await authRevokeOtherSessions()
  } catch {
    return null
  }
}

export const updateAvatar = async (avatar: string | null): Promise<boolean> => {
  try {
    const { user } = await authUpdateAvatar(avatar)
    set({ user })
    return true
  } catch {
    return false
  }
}

export const clearAuthError = (): void => set({ error: null, errorText: null })

/** 从访客界面切到登录页 */
export const openLogin = (): void => set({ loginPrompt: true, error: null, errorText: null })

/** 关掉登录页，回到访客对话（本机会话还在） */
export const closeLogin = (): void => set({ loginPrompt: false })
