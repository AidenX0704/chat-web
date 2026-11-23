/**
 * 后端模式判断与令牌存取。
 * 这里刻意不引用任何请求模块或 UI，避免循环依赖。
 */

const RAW_BACKEND_ORIGIN = __BACKEND_ORIGIN__.trim()

/** 是否启用了服务端代理 + 登录（'/' / 'same-origin' 表示同源代理，留空或 'none' 表示纯静态部署） */
export const isBackendMode = RAW_BACKEND_ORIGIN !== '' && RAW_BACKEND_ORIGIN !== 'none'

/** 后端请求前缀：同源部署时为空串（直接请求 /api/...），分站部署时去掉尾斜杠 */
export const BACKEND_ORIGIN =
  !isBackendMode || RAW_BACKEND_ORIGIN === '/' || RAW_BACKEND_ORIGIN === 'same-origin'
    ? ''
    : RAW_BACKEND_ORIGIN.replace(/\/+$/, '')

/**
 * 当前是否以访客身份使用：接入后端但未登录。
 * 访客能用服务端代理对话（每天有限次数），但会话只存在本机，
 * 所以存储要走本地 IndexedDB，而不是需要登录态的 /api/chats。
 */
let guest = false

export const isGuestMode = (): boolean => guest

export const setGuestMode = (next: boolean): void => {
  guest = next
}

/** 会话与附件是否存服务端：接入后端且已登录时才走远端存储 */
export const usesRemoteStorage = (): boolean => isBackendMode && !guest

/** 当前标签页的唯一标识：写入时带给服务端，用来抑制 SSE 回声（不挡其他标签页和其他设备） */
export const CLIENT_ID =
  typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`

const TOKEN_KEY = 'chat-personal:session-token'

/**
 * 同源部署时用 httpOnly Cookie（前端根本拿不到令牌，最安全）；
 * 跨站部署时浏览器会拦第三方 Cookie，只能退化成 Bearer 令牌。
 */
export const usesBearerToken = (): boolean => {
  if (!isBackendMode || BACKEND_ORIGIN === '') {
    return false
  }
  try {
    return new URL(BACKEND_ORIGIN, window.location.href).origin !== window.location.origin
  } catch {
    return true
  }
}

let token: string | null = null

export const getSessionToken = (): string | null => token

export const setSessionToken = (next: string | null): void => {
  token = next
  try {
    if (next === null) {
      localStorage.removeItem(TOKEN_KEY)
    } else {
      localStorage.setItem(TOKEN_KEY, next)
    }
  } catch {
    // 隐私模式下 localStorage 不可用时只保留在内存里
  }
}

/** 刷新页面后恢复上次的令牌 */
export const restoreSessionToken = (): void => {
  if (!usesBearerToken()) {
    return
  }
  try {
    token = localStorage.getItem(TOKEN_KEY)
  } catch {
    token = null
  }
}

const unauthorizedListeners = new Set<() => void>()

/** 任意请求拿到 401 时回调，用来把界面切回登录页 */
export const onUnauthorized = (listener: () => void): (() => void) => {
  unauthorizedListeners.add(listener)
  return () => {
    unauthorizedListeners.delete(listener)
  }
}

export const notifyUnauthorized = (): void => {
  for (const listener of unauthorizedListeners) {
    listener()
  }
}
