import { copyText } from '../../utils/clipboard.js'
import { ApiError, request } from '../api/client.js'
import { BACKEND_ORIGIN, usesRemoteStorage } from '../auth/session.js'
import { getVisibleMessages } from './branches.js'
import * as db from './db.js'
import { useChatStore } from './store.js'
import type { Message, Session } from './types.js'

/** 分享文案里用到的角色名，由界面按当前语言传入 */
export type ShareLabels = { untitled: string; user: string; assistant: string }

/** 分享页的路由前缀：链接形如 https://站点/s/<token> */
export const SHARE_PATH_PREFIX = '/s/'

/** 令牌形状与服务端一致（base64url，16~64 位）；不合形状的直接当无效链接 */
const SHARE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{16,64}$/
/** 当前地址是不是分享页；是则取出令牌 */
const SHARE_ROUTE_PATTERN = /^\/s\/([A-Za-z0-9_-]{16,64})\/?$/

export const isShareToken = (value: string): boolean => SHARE_TOKEN_PATTERN.test(value)

export const readShareToken = (pathname: string): string | null => {
  const matched = SHARE_ROUTE_PATTERN.exec(pathname)
  return matched?.[1] ?? null
}

/** 分享链接按当前站点的域名拼：同一份前端既可能部署在主站，也可能部署在独立域名上 */
export const shareUrlOf = (token: string): string =>
  new URL(`${SHARE_PATH_PREFIX}${token}`, window.location.origin).toString()

const messageText = (message: Message): string => {
  if (message.role === 'user') {
    return message.content
  }
  return message.blocks
    .map((block) => (block.type === 'text' ? block.text : ''))
    .filter((text) => text !== '')
    .join('\n')
}

/** 会话转 Markdown：标题 + 当前分支上每条消息的角色与正文，附件按文件名列出 */
export const sessionToMarkdown = (
  session: Session,
  labels: ShareLabels,
  messageIds: string[] | null = null
): string => {
  const lines: string[] = ['# ' + (session.title.trim() || labels.untitled), '']
  const wanted = messageIds === null ? null : new Set(messageIds)
  for (const message of getVisibleMessages(session)) {
    if (wanted !== null && !wanted.has(message.id)) {
      continue
    }
    const text = messageText(message).trim()
    const files = message.role === 'user' ? message.files.map((file) => file.name) : []
    if (text === '' && files.length === 0) {
      continue
    }
    lines.push('**' + (message.role === 'user' ? labels.user : labels.assistant) + '：**', '')
    if (text !== '') {
      lines.push(text, '')
    }
    if (files.length > 0) {
      lines.push(files.map((name) => '- ' + name).join('\n'), '')
    }
  }
  return lines.join('\n').trim() + '\n'
}

/** 分享会话：优先用已打开的会话缓存，没有就按 id 读一次，再复制成 Markdown */
const copySessionAsMarkdown = async (
  id: string,
  labels: ShareLabels,
  messageIds: string[] | null
): Promise<boolean> => {
  const cache = useChatStore.getState().sessionCache
  try {
    const session = Object.hasOwn(cache, id) ? cache[id] : await db.loadSession(id)
    return session ? await copyText(sessionToMarkdown(session, labels, messageIds)) : false
  } catch (error) {
    db.reportStorageError('share session')(error)
    return false
  }
}

/**
 * 分享的结果：
 * - link：生成（或复用）了公开链接，copied 表示是否已写进剪贴板；
 * - markdown：纯静态部署没有后端，退化成复制 Markdown 正文；
 * - failed：既没生成链接也没复制成功。
 */
export type ShareResult =
  | { kind: 'link'; url: string; copied: boolean }
  | { kind: 'markdown' }
  | { kind: 'failed' }

/** 让服务端生成（或刷新）指定会话的公开分享令牌；传 messageIds 时只快照这些消息 */
const createShareToken = async (
  id: string,
  messageIds: string[] | null
): Promise<string | null> => {
  try {
    const response = await request(`${BACKEND_ORIGIN}/api/chats/${encodeURIComponent(id)}/share`, {
      method: 'POST',
      ...(messageIds === null
        ? {}
        : {
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ messageIds }),
          }),
    })
    const body = (await response.json()) as { share?: { token?: unknown } }
    const token = body.share?.token
    return typeof token === 'string' && isShareToken(token) ? token : null
  } catch {
    return null
  }
}

/**
 * 分享会话：接入后端时生成公开链接（不需要登录、不需要口令）并复制到剪贴板；
 * 纯静态部署没有服务端可存，退化成复制 Markdown 正文。
 */
export const shareSession = async (
  id: string,
  labels: ShareLabels,
  /** 只分享选中的消息；null 表示整段会话 */
  messageIds: string[] | null = null
): Promise<ShareResult> => {
  // 访客的会话只在本机，服务端没有可分享的记录，和纯静态部署一样退化成复制正文
  if (!usesRemoteStorage()) {
    return (await copySessionAsMarkdown(id, labels, messageIds))
      ? { kind: 'markdown' }
      : { kind: 'failed' }
  }
  const token = await createShareToken(id, messageIds)
  if (token === null) {
    return { kind: 'failed' }
  }
  const url = shareUrlOf(token)
  return { kind: 'link', url, copied: await copyText(url) }
}

/** 分享页读到的内容：会话快照 + 分享时间 */
export type SharedSession = { token: string; title: string; createdAt: number; session: Session }

/** 打不开分享页的原因：链接失效、网络不通、服务端异常 */
export type ShareFailure = 'invalid' | 'network' | 'server'

export class ShareLinkError extends Error {
  constructor(readonly reason: ShareFailure) {
    super(reason)
    this.name = 'ShareLinkError'
  }
}

const readSharedSession = (body: unknown, token: string): SharedSession | null => {
  const share = (body as { share?: unknown } | null)?.share
  if (typeof share !== 'object' || share === null) {
    return null
  }
  const { title, createdAt, session } = share as {
    title?: unknown
    createdAt?: unknown
    session?: unknown
  }
  if (typeof session !== 'object' || session === null) {
    return null
  }
  const parsed = session as Partial<Session>
  if (!Array.isArray(parsed.messages) || typeof parsed.id !== 'string') {
    return null
  }
  return {
    token,
    title: typeof title === 'string' ? title : (parsed.title ?? ''),
    createdAt: typeof createdAt === 'number' ? createdAt : (parsed.createdAt ?? 0),
    session: parsed as Session,
  }
}

/** 读取分享页内容：不需要登录态，凭链接里的令牌即可 */
export const fetchSharedSession = async (token: string): Promise<SharedSession> => {
  let body: unknown
  try {
    const response = await request(`${BACKEND_ORIGIN}/api/shares/${encodeURIComponent(token)}`, {
      method: 'GET',
    })
    body = await response.json()
  } catch (error) {
    if (error instanceof ApiError) {
      throw new ShareLinkError(
        error.kind === 'network' ? 'network' : error.status === 404 ? 'invalid' : 'server'
      )
    }
    throw new ShareLinkError('server')
  }
  const shared = readSharedSession(body, token)
  if (shared === null) {
    throw new ShareLinkError('invalid')
  }
  return shared
}

/** 「数据管理」里的分享链接条目 */
export type SharedLink = {
  token: string
  /** 可以直接打开的地址 */
  url: string
  title: string
  chatId: string
  createdAt: number
  updatedAt: number
}

const toSharedLink = (value: unknown): SharedLink | null => {
  if (typeof value !== 'object' || value === null) {
    return null
  }
  const item = value as {
    token?: unknown
    title?: unknown
    chatId?: unknown
    createdAt?: unknown
    updatedAt?: unknown
  }
  if (typeof item.token !== 'string' || !isShareToken(item.token)) {
    return null
  }
  return {
    token: item.token,
    url: shareUrlOf(item.token),
    title: typeof item.title === 'string' ? item.title : '',
    chatId: typeof item.chatId === 'string' ? item.chatId : '',
    createdAt: typeof item.createdAt === 'number' ? item.createdAt : 0,
    updatedAt: typeof item.updatedAt === 'number' ? item.updatedAt : 0,
  }
}

/** 列出当前账号名下仍然有效的分享链接（需要登录） */
export const listSharedLinks = async (): Promise<SharedLink[]> => {
  const response = await request(`${BACKEND_ORIGIN}/api/shares`, { method: 'GET' })
  const body = (await response.json()) as { shares?: unknown }
  if (!Array.isArray(body.shares)) {
    return []
  }
  return body.shares
    .map(toSharedLink)
    .filter((item): item is SharedLink => item !== null)
    .sort((a, b) => b.updatedAt - a.updatedAt)
}

/** 撤销一条分享链接：撤销后旧链接立即失效 */
export const revokeSharedLink = async (token: string): Promise<void> => {
  await request(`${BACKEND_ORIGIN}/api/shares/${encodeURIComponent(token)}`, { method: 'DELETE' })
}
