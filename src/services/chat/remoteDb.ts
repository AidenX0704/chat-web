import { readServerSentEvents } from '../api/sse.js'
import {
  BACKEND_ORIGIN,
  CLIENT_ID,
  getSessionToken,
  notifyUnauthorized,
  usesBearerToken,
} from '../auth/session.js'
import * as local from './localDb.js'
import type { StoredFile } from './localDb.js'
import { toSessionSummary, type Message, type Session, type SessionSummary } from './types.js'

/**
 * 服务端存储实现：会话按「消息行」存在后端 SQLite 里，多端共享同一份数据。
 *
 * 三个关键点：
 * 1. 列表只要元数据（标题），正文按需拉取 —— 侧边栏因此很快出现；
 * 2. 保存只提交**有变化的消息**（流式生成时就是正在生成的那一条），不再整份会话 JSON 来回搬；
 * 3. 写操作带版本号做乐观锁，冲突时先整份重拉、按消息 id 合并再重试，两台设备同时说话不丢消息。
 */

/** 流式生成时 store 会频繁触发保存，服务端写入合并到最多 400ms 一次；生成结束则立即落盘 */
const MIN_WRITE_INTERVAL_MS = 400
const MAX_CONFLICT_RETRIES = 3
/** SSE 断线重连退避基数与上限 */
const SSE_RETRY_BASE_MS = 1000
const SSE_RETRY_MAX_MS = 15_000

type ChatSummaryRow = {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  version: number
  messageCount: number
}

type ChatRow = ChatSummaryRow & { session: Session }

export type ChatDelta = {
  id: string
  title: string
  updatedAt: number
  version: number
  rootMessageId: string | null
  deleted: string[]
  messages: Message[]
}

export type SessionEventHandlers = {
  onDelta: (delta: ChatDelta) => void
  onResync: (reason: string) => void
  onDeleted: () => void
  onNotFound: () => void
}

/** 增量同步结果：有内容更新 / 没有变化 / 拿不到增量 */
export type SyncResult =
  | { applied: Session }
  | { unchanged: true }
  | { unavailable: true }

class RemoteError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string
  ) {
    super(message)
    this.name = 'RemoteError'
  }
}

const headers = (extra: Record<string, string> = {}): Headers => {
  const result = new Headers(extra)
  result.set('x-session-mode', usesBearerToken() ? 'bearer' : 'cookie')
  result.set('x-client-id', CLIENT_ID)
  const token = getSessionToken()
  if (token) {
    result.set('authorization', `Bearer ${token}`)
  }
  return result
}

const call = async <T>(path: string, init: RequestInit = {}): Promise<T> => {
  let response: Response
  try {
    response = await fetch(`${BACKEND_ORIGIN}/api${path}`, {
      ...init,
      headers: headers(init.headers as Record<string, string> | undefined),
      credentials: 'include',
    })
  } catch {
    throw new RemoteError(0, 'network', '网络错误')
  }
  if (response.status === 401) {
    notifyUnauthorized()
    throw new RemoteError(401, 'unauthorized', '登录已失效')
  }
  if (response.status === 204) {
    return undefined as T
  }
  const text = await response.text()
  const body = text === '' ? null : (JSON.parse(text) as unknown)
  if (!response.ok) {
    const error = (body as { error?: { code?: string; message?: string } } | null)?.error
    throw new RemoteError(
      response.status,
      error?.code ?? 'unknown',
      error?.message ?? `请求失败（${response.status}）`
    )
  }
  return body as T
}

// ---------------------------------------------------------------- 本地已知状态

/** 每条消息的内容指纹（含位置）；用对象身份做缓存，避免每次保存都重新序列化整份会话 */
const fingerprintCache = new WeakMap<object, string>()

const fingerprintOf = (message: Message): string => {
  const key = message as object
  const cached = fingerprintCache.get(key)
  if (cached !== undefined) {
    return cached
  }
  const value = JSON.stringify(message)
  fingerprintCache.set(key, value)
  return value
}

type ChatState = {
  /** 本地最后一次与服务端一致时的会话版本 */
  version: number
  /** 消息 id → 「位置 + 内容指纹」 */
  fingerprints: Map<string, string>
}

const states = new Map<string, ChatState>()

const fingerprintsFrom = (session: Session): Map<string, string> =>
  new Map(session.messages.map((message, position) => [message.id, `${position}|${fingerprintOf(message)}`]))

/** 已经上传过的原件，避免重复上传 */
const uploaded = new Set<string>()

/** 冲突合并后通知上层刷新，让界面和服务端保持一致 */
let mergeListener: ((sessionId: string) => void) | null = null
export const setMergeListener = (listener: ((sessionId: string) => void) | null): void => {
  mergeListener = listener
}

// ---------------------------------------------------------------- 合并（冲突时）

const statusRank = (message: Message): number => {
  // 用户消息没有状态，平手时优先保留它
  if (message.role === 'user') {
    return 5
  }
  switch (message.status) {
    case 'done':
      return 4
    case 'stopped':
      return 3
    case 'error':
      return 2
    case 'streaming':
      return 1
    default:
      return 0
  }
}

const textLength = (message: Message): number => {
  if (message.role === 'user') {
    return message.content.length
  }
  return message.blocks.reduce((total, block) => {
    if (block.type === 'text') {
      return total + block.text.length
    }
    if (block.type === 'thinking') {
      return total + block.thinking.length
    }
    return total
  }, 0)
}

/**
 * 同一条消息在两台设备上内容不同时保留更完整的那个。
 * 先比内容长度：另一台设备可能正在流式生成，把它截成「已停止」是错的；
 * 内容一样长时才看状态（done 优于 streaming）。
 */
const richerMessage = (a: Message, b: Message): Message => {
  const lengthDiff = textLength(a) - textLength(b)
  if (lengthDiff !== 0) {
    return lengthDiff > 0 ? a : b
  }
  return statusRank(a) >= statusRank(b) ? a : b
}

/**
 * 合并两台设备的同一会话：消息按 id 取并集（id 是客户端生成的 UUID，不会撞车），
 * 标题取更新时间更晚的一方。聊天是「追加式」的，并集足以得到双方都看到的完整对话。
 */
export const mergeSessions = (localSession: Session, remoteSession: Session): Session => {
  if (localSession.id !== remoteSession.id) {
    return localSession
  }
  const merged = new Map<string, Message>()
  for (const message of remoteSession.messages) {
    merged.set(message.id, message)
  }
  for (const message of localSession.messages) {
    const existing = merged.get(message.id)
    merged.set(message.id, existing ? richerMessage(existing, message) : message)
  }
  const messages = [...merged.values()].sort((a, b) => a.createdAt - b.createdAt)
  const newer = localSession.updatedAt >= remoteSession.updatedAt ? localSession : remoteSession
  const older = newer === localSession ? remoteSession : localSession
  const title =
    localSession.title === '' ? remoteSession.title
    : remoteSession.title === '' ? localSession.title
    : newer.title
  return {
    ...older,
    ...newer,
    title,
    messages,
    rootMessageId: newer.rootMessageId ?? older.rootMessageId,
    updatedAt: Math.max(localSession.updatedAt, remoteSession.updatedAt),
    createdAt: Math.min(localSession.createdAt, remoteSession.createdAt),
  }
}

// ---------------------------------------------------------------- 读写

export const loadSessionSummaries = async (): Promise<SessionSummary[]> => {
  const body = await call<{ chats: ChatSummaryRow[] }>('/chats')
  const alive = new Set(body.chats.map((row) => row.id))
  for (const id of [...states.keys()]) {
    if (!alive.has(id)) {
      states.delete(id)
    }
  }
  return body.chats.map(toSessionSummary)
}

export const loadSession = async (id: string): Promise<Session | undefined> => {
  try {
    const body = await call<{ chat: ChatRow }>(`/chats/${encodeURIComponent(id)}`)
    states.set(id, { version: body.chat.version, fingerprints: fingerprintsFrom(body.chat.session) })
    return body.chat.session
  } catch (error) {
    if (error instanceof RemoteError && error.status === 404) {
      states.delete(id)
      return undefined
    }
    throw error
  }
}

const uploadFiles = async (files: StoredFile[]): Promise<void> => {
  for (const file of files) {
    if (uploaded.has(file.id)) {
      continue
    }
    await call(`/files/${encodeURIComponent(file.id)}`, {
      method: 'PUT',
      headers: { 'content-type': file.blob.type || 'application/octet-stream' },
      body: file.blob,
    })
    uploaded.add(file.id)
  }
}

const collectFileIds = (session: Session): string[] => {
  const ids = new Set<string>()
  for (const message of session.messages) {
    if (message.role === 'user') {
      for (const file of message.files) {
        ids.add(file.id)
      }
    }
  }
  return [...ids]
}

/** 与服务端最后一次同步状态做差：只把新增或变化的消息、以及被删掉的 id 发出去 */
const diffSession = (session: Session, state: ChatState | undefined) => {
  const upsert: { position: number; message: Message }[] = []
  const current = new Set<string>()
  session.messages.forEach((message, position) => {
    current.add(message.id)
    const fingerprint = `${position}|${fingerprintOf(message)}`
    if (state?.fingerprints.get(message.id) !== fingerprint) {
      upsert.push({ position, message })
    }
  })
  const deleted: string[] = []
  if (state) {
    for (const id of state.fingerprints.keys()) {
      if (!current.has(id)) {
        deleted.push(id)
      }
    }
  }
  return { upsert, deleted }
}

const commitState = (
  id: string,
  version: number,
  changes: { upsert: { position: number; message: Message }[]; deleted: string[] }
) => {
  const state = states.get(id) ?? { version, fingerprints: new Map<string, string>() }
  state.version = version
  for (const item of changes.upsert) {
    state.fingerprints.set(item.message.id, `${item.position}|${fingerprintOf(item.message)}`)
  }
  for (const deletedId of changes.deleted) {
    state.fingerprints.delete(deletedId)
  }
  states.set(id, state)
}

/** 整份重拉（冲突或版本超前时用），返回服务端当前会话 */
const reloadRemote = async (id: string): Promise<Session> => {
  const body = await call<{ chat: ChatRow }>(`/chats/${encodeURIComponent(id)}`)
  states.set(id, { version: body.chat.version, fingerprints: fingerprintsFrom(body.chat.session) })
  return body.chat.session
}

const hasStreamingMessage = (session: Session): boolean =>
  session.messages.some(
    (message) =>
      message.role === 'assistant' &&
      (message.status === 'pending' || message.status === 'streaming')
  )

const mergeStoredFiles = (a: StoredFile[], b: StoredFile[]): StoredFile[] => {
  if (a.length === 0) {
    return b
  }
  if (b.length === 0) {
    return a
  }
  const byId = new Map<string, StoredFile>()
  for (const file of a) {
    byId.set(file.id, file)
  }
  for (const file of b) {
    byId.set(file.id, file)
  }
  return [...byId.values()]
}

const putSession = async (input: Session, files: StoredFile[]): Promise<void> => {
  await uploadFiles(files)
  let candidate = input
  for (let attempt = 0; attempt <= MAX_CONFLICT_RETRIES; attempt += 1) {
    const state = states.get(candidate.id)
    const changes = diffSession(candidate, state)
    const updatedAt = hasStreamingMessage(candidate)
      ? Math.max(candidate.updatedAt, Date.now())
      : candidate.updatedAt
    try {
      const body = await call<{ version: number; updatedAt: number }>(
        `/chats/${encodeURIComponent(candidate.id)}`,
        {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            baseVersion: state?.version ?? null,
            title: candidate.title,
            createdAt: candidate.createdAt,
            updatedAt,
            rootMessageId: candidate.rootMessageId ?? null,
            upsert: changes.upsert,
            deleted: changes.deleted,
            fileIds: collectFileIds(candidate),
          }),
        }
      )
      commitState(candidate.id, body.version, changes)
      return
    } catch (error) {
      if (!(error instanceof RemoteError) || error.status !== 409) {
        throw error
      }
      // 另一台设备先写了：整份重拉、按消息合并，再算一次差量重试
      const remote = await reloadRemote(candidate.id)
      candidate = mergeSessions(candidate, remote)
      mergeListener?.(candidate.id)
    }
  }
  throw new RemoteError(409, 'version_conflict', '会话在多个设备上同时修改，保存失败')
}

type Job = {
  session: Session
  files: StoredFile[]
  immediate: boolean
  resolve: () => void
  reject: (error: unknown) => void
}

type QueueEntry = {
  pending: Job | null
  running: boolean
  wake: (() => void) | null
}

const queues = new Map<string, QueueEntry>()
const lastWriteAt = new Map<string, number>()

const drain = async (id: string): Promise<void> => {
  const entry = queues.get(id)
  if (!entry || entry.running) {
    return
  }
  entry.running = true
  try {
    while (entry.pending) {
      const job = entry.pending
      entry.pending = null
      const elapsed = Date.now() - (lastWriteAt.get(id) ?? 0)
      if (!job.immediate && elapsed < MIN_WRITE_INTERVAL_MS) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            entry.wake = null
            resolve()
          }, MIN_WRITE_INTERVAL_MS - elapsed)
          entry.wake = () => {
            clearTimeout(timer)
            entry.wake = null
            resolve()
          }
        })
        // 合并等待期间更晚的快照会顶替这一份，保留尚未上传的原件后跳过旧快照
        const supersededBy = queues.get(id)?.pending
        if (supersededBy) {
          supersededBy.files = mergeStoredFiles(job.files, supersededBy.files)
          job.resolve()
          continue
        }
      }
      lastWriteAt.set(id, Date.now())
      try {
        await putSession(job.session, job.files)
        job.resolve()
      } catch (error) {
        job.reject(error)
      }
    }
  } finally {
    entry.running = false
    entry.wake = null
    if (queues.get(id) === entry && !entry.pending) {
      queues.delete(id)
    }
  }
}

/** 同一会话的并发保存合并成「最后一次快照」：流式期间节流，落定后立即写回服务端 */
export const saveSession = (session: Session, files: StoredFile[] = []): Promise<void> =>
  new Promise((resolve, reject) => {
    const immediate = !hasStreamingMessage(session)
    const entry = queues.get(session.id) ?? { pending: null, running: false, wake: null }
    queues.set(session.id, entry)
    const previous = entry.pending
    const mergedFiles = previous ? mergeStoredFiles(previous.files, files) : files
    entry.pending = { session, files: mergedFiles, immediate, resolve, reject }
    if (previous) {
      previous.resolve()
    }
    if (immediate) {
      entry.wake?.()
    }
    void drain(session.id)
  })

export const saveFiles = async (files: StoredFile[]): Promise<void> => {
  await uploadFiles(files)
}

export const loadFile = async (id: string): Promise<Blob | undefined> => {
  let response: Response
  try {
    response = await fetch(`${BACKEND_ORIGIN}/api/files/${encodeURIComponent(id)}`, {
      headers: headers(),
      credentials: 'include',
    })
  } catch {
    return undefined
  }
  if (response.status === 401) {
    notifyUnauthorized()
    return undefined
  }
  if (!response.ok) {
    return undefined
  }
  return await response.blob()
}

export const renameSession = async (id: string, title: string): Promise<void> => {
  const body = await call<{ version?: number }>(`/chats/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title }),
  })
  const state = states.get(id)
  if (state && typeof body.version === 'number') {
    state.version = body.version
  }
}

export const deleteSession = async (id: string): Promise<void> => {
  await call(`/chats/${encodeURIComponent(id)}`, { method: 'DELETE' })
  states.delete(id)
  queues.delete(id)
  lastWriteAt.delete(id)
}

export const hasSyncedSession = (id: string): boolean => states.has(id)

/** 退出登录或切换账号时清空本地同步状态，避免跨账号串数据 */
export const resetRemoteState = (): void => {
  for (const entry of queues.values()) {
    entry.wake?.()
    entry.pending?.resolve()
    entry.pending = null
  }
  queues.clear()
  states.clear()
  uploaded.clear()
  lastWriteAt.clear()
}

/**
 * 把服务端增量（来自轮询 /messages?since= 或 SSE /events）应用到本地会话，
 * 同时推进本地版本号与指纹；若本地版本已不落后，返回 null。
 */
export const applySessionDelta = (session: Session, delta: ChatDelta): Session | null => {
  if (session.id !== delta.id) {
    return null
  }
  const existing = states.get(session.id)
  if (existing && delta.version <= existing.version) {
    return null
  }

  const byId = new Map<string, Message>(session.messages.map((message) => [message.id, message]))
  const order = session.messages.map((message) => message.id)
  const appended: string[] = []
  for (const message of delta.messages) {
    if (!byId.has(message.id)) {
      appended.push(message.id)
    }
    byId.set(message.id, message)
  }
  const removed = new Set(delta.deleted)
  const messages: Message[] = []
  for (const id of order) {
    if (removed.has(id)) {
      continue
    }
    const message = byId.get(id)
    if (message) {
      messages.push(message)
    }
  }
  for (const id of appended) {
    if (removed.has(id)) {
      continue
    }
    const message = byId.get(id)
    if (message) {
      messages.push(message)
    }
  }

  const next: Session = {
    ...session,
    title: delta.title,
    updatedAt: delta.updatedAt,
    rootMessageId: delta.rootMessageId ?? session.rootMessageId,
    messages,
  }
  states.set(session.id, {
    version: delta.version,
    fingerprints: fingerprintsFrom(next),
  })
  return next
}

/**
 * 增量同步：只拉 since 之后变化的消息与被删掉的 id，局部更新本地缓存。
 * 拿不到增量（没同步过、版本超前）时返回 unavailable，由调用方整份重拉。
 */
export const syncSession = async (session: Session): Promise<SyncResult> => {
  const state = states.get(session.id)
  if (!state) {
    return { unavailable: true }
  }
  let body: { chat: ChatDelta }
  try {
    body = await call<{ chat: ChatDelta }>(
      `/chats/${encodeURIComponent(session.id)}/messages?since=${state.version}`
    )
  } catch (error) {
    if (error instanceof RemoteError && (error.status === 409 || error.status === 404)) {
      states.delete(session.id)
      return { unavailable: true }
    }
    throw error
  }
  const applied = applySessionDelta(session, body.chat)
  if (!applied) {
    return { unchanged: true }
  }
  return { applied }
}

/**
 * 订阅单个会话的 SSE 实时推送（GET /api/chats/:id/events?since=N）。
 * 使用 fetch + readServerSentEvents，同源 Cookie 与跨站 Bearer 令牌均可用，
 * 断线时指数退避重连，恢复联网或切回标签页立即重试。
 */
export const subscribeSession = (id: string, handlers: SessionEventHandlers): (() => void) => {
  let stopped = false
  let attempt = 0
  let controller: AbortController | null = null
  let retryTimer: ReturnType<typeof setTimeout> | null = null

  const clearRetry = () => {
    if (retryTimer !== null) {
      clearTimeout(retryTimer)
      retryTimer = null
    }
  }

  const scheduleReconnect = () => {
    if (stopped || retryTimer !== null) {
      return
    }
    const delay = Math.min(SSE_RETRY_BASE_MS * 2 ** attempt, SSE_RETRY_MAX_MS)
    attempt += 1
    retryTimer = setTimeout(() => {
      retryTimer = null
      void connect()
    }, delay)
  }

  const connect = async () => {
    if (stopped || controller !== null) {
      return
    }
    const current = new AbortController()
    controller = current
    try {
      const state = states.get(id)
      const since = state ? `?since=${state.version}` : ''
      const response = await fetch(
        `${BACKEND_ORIGIN}/api/chats/${encodeURIComponent(id)}/events${since}`,
        {
          method: 'GET',
          headers: headers({ accept: 'text/event-stream' }),
          credentials: 'include',
          signal: current.signal,
        }
      )
      if (stopped || current.signal.aborted) {
        return
      }
      if (response.status === 401) {
        stopped = true
        notifyUnauthorized()
        return
      }
      if (response.status === 404) {
        stopped = true
        handlers.onNotFound()
        return
      }
      const contentType = response.headers.get('content-type') ?? ''
      if (!response.ok || !response.body || !contentType.includes('text/event-stream')) {
        return
      }
      attempt = 0
      for await (const frame of readServerSentEvents(response.body, current.signal)) {
        if (stopped) {
          return
        }
        let payload: unknown
        try {
          payload = JSON.parse(frame.data)
        } catch {
          continue
        }
        if (frame.event === 'delta') {
          handlers.onDelta(payload as ChatDelta)
        } else if (frame.event === 'resync') {
          states.delete(id)
          const reason =
            typeof (payload as { reason?: unknown })?.reason === 'string'
              ? (payload as { reason: string }).reason
              : 'resync'
          handlers.onResync(reason)
        } else if (frame.event === 'deleted') {
          stopped = true
          states.delete(id)
          handlers.onDeleted()
          return
        }
      }
    } catch {
      // 网络断开或被主动取消：下面统一按 stopped 判断是否重连
    } finally {
      if (controller === current) {
        controller = null
      }
      if (!stopped) {
        scheduleReconnect()
      }
    }
  }

  const wake = () => {
    if (stopped || controller !== null) {
      return
    }
    clearRetry()
    attempt = 0
    void connect()
  }

  const onVisibility = () => {
    if (document.visibilityState === 'visible') {
      wake()
    }
  }

  window.addEventListener('online', wake)
  document.addEventListener('visibilitychange', onVisibility)
  void connect()

  return () => {
    stopped = true
    clearRetry()
    window.removeEventListener('online', wake)
    document.removeEventListener('visibilitychange', onVisibility)
    controller?.abort()
    controller = null
  }
}

/**
 * 导入提交：把暂存区（IndexedDB，仅作解析缓冲）里的会话整体推给服务端替换，
 * 再上传原件。服务端整库替换是一个事务，中途失败不会留下半份数据。
 */
export const commitStaging = async (): Promise<SessionSummary[]> => {
  const sessions = await local.readStagingSessions()
  const files = await local.readStagingFiles()
  await call('/chats/import', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessions }),
  })
  await uploadFiles(files)
  await local.clearStaging()
  states.clear()
  return sessions.map(toSessionSummary)
}
