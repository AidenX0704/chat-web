import { useChatStore } from './store.js'
import * as db from './db.js'
import { getVisibleMessages } from './branches.js'
import type { Message, Session, SessionSummary } from './types.js'

/** 一条搜索结果：命中的是会话标题，或者某条消息里的文字 */
export type SessionSearchHit = {
  sessionId: string
  /** 会话标题，可能为空（未命名对话），由界面决定兜底文案 */
  title: string
  updatedAt: number
  /** 标题命中时为空 */
  messageId?: string
  role?: 'user' | 'assistant'
  /** 命中位置前后的上下文片段，命中词单独拿出来方便高亮 */
  before: string
  match: string
  after: string
}

export type SearchOptions = {
  /** 最多返回多少条结果，默认 60 */
  limit?: number
  /** 每扫完一个会话回调一次，界面可以先展示部分结果 */
  onProgress?: (hits: SessionSearchHit[]) => void
  signal?: AbortSignal
}

/** 单个会话最多返回多少条消息命中，避免一个长会话淹没其他结果 */
const MAX_HITS_PER_SESSION = 5
/** 片段里命中词前后各保留多少字符 */
const SNIPPET_RADIUS = 28
/** 并发读取的会话数：接入后端时每次读取都是一次请求 */
const LOAD_CONCURRENCY = 4

/** 消息里可供搜索的纯文本：用户取正文，助手取全部文本块 */
const messageText = (message: Message): string => {
  if (message.role === 'user') {
    return message.content
  }
  return message.blocks
    .map((block) => (block.type === 'text' ? block.text : ''))
    .filter((text) => text !== '')
    .join('\n')
}

/** 把命中位置前后裁成一行片段；换行折叠成空格，避免结果列表里高低不齐 */
const sliceSnippet = (text: string, index: number, length: number) => {
  const start = Math.max(0, index - SNIPPET_RADIUS)
  const end = Math.min(text.length, index + length + SNIPPET_RADIUS)
  const fold = (value: string) => value.replace(/\s+/g, ' ')
  return {
    before: (start > 0 ? '…' : '') + fold(text.slice(start, index)),
    match: text.slice(index, index + length),
    after: fold(text.slice(index + length, end)) + (end < text.length ? '…' : ''),
  }
}

const cachedSession = (id: string): Session | undefined => {
  const cache = useChatStore.getState().sessionCache
  return Object.hasOwn(cache, id) ? cache[id] : undefined
}

/** 读取会话正文；单个会话读取失败（如被别的设备删掉）只跳过它 */
const loadSession = async (id: string): Promise<Session | undefined> => {
  const cached = cachedSession(id)
  if (cached) {
    return cached
  }
  try {
    return await db.loadSession(id)
  } catch {
    return undefined
  }
}

const sortHits = (hits: SessionSearchHit[], limit: number): SessionSearchHit[] =>
  // 最近更新过的会话排前面；同一次搜索里同一会话的命中保持消息顺序（sort 稳定）
  [...hits].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, limit)

const collectHits = async (
  summary: SessionSummary,
  needle: string
): Promise<SessionSearchHit[]> => {
  const hits: SessionSearchHit[] = []
  const { id } = summary
  const title = summary.title
  const base = { sessionId: id, title, updatedAt: summary.updatedAt }
  const titleIndex = title.toLowerCase().indexOf(needle)
  if (titleIndex >= 0) {
    hits.push({ ...base, ...sliceSnippet(title, titleIndex, needle.length) })
  }
  const session = await loadSession(id)
  if (!session) {
    return hits
  }
  let matched = 0
  for (const message of getVisibleMessages(session)) {
    if (matched >= MAX_HITS_PER_SESSION) {
      break
    }
    const text = messageText(message)
    const index = text.toLowerCase().indexOf(needle)
    if (index < 0) {
      continue
    }
    matched += 1
    hits.push({
      ...base,
      messageId: message.id,
      role: message.role,
      ...sliceSnippet(text, index, needle.length),
    })
  }
  return hits
}

/**
 * 搜索全部对话：按会话逐个读取本地缓存（没有缓存时从存储读取），
 * 收集标题与消息正文的命中。结果按会话更新时间排序，可用 onProgress 做流式展示。
 */
export const searchSessions = async (
  query: string,
  options: SearchOptions = {}
): Promise<SessionSearchHit[]> => {
  const needle = query.trim().toLowerCase()
  if (needle === '') {
    return []
  }
  const { limit = 60, onProgress, signal } = options
  const summaries = useChatStore.getState().sessions
  const hits: SessionSearchHit[] = []
  let cursor = 0

  const worker = async (): Promise<void> => {
    for (;;) {
      if (signal?.aborted) {
        return
      }
      const summary = summaries[cursor]
      cursor += 1
      if (!summary) {
        return
      }
      const found = await collectHits(summary, needle)
      if (signal?.aborted) {
        return
      }
      if (found.length > 0) {
        hits.push(...found)
        onProgress?.(sortHits(hits, limit))
      }
    }
  }

  await Promise.all(Array.from({ length: LOAD_CONCURRENCY }, worker))
  return sortHits(hits, limit)
}
