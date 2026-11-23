import { usesRemoteStorage } from '../auth/session.js'
import * as local from './localDb.js'
import * as remote from './remoteDb.js'

/**
 * 存储门面。
 *
 * - 纯静态部署：全部读写 IndexedDB（原有行为，离线可用）；
 * - 接入后端并已登录：会话与附件存服务端，多端共享；IndexedDB 只用于历史导入的解析暂存；
 * - 接入后端但未登录（访客）：只能对话，会话存本机，登录后换成服务端历史。
 *
 * 上层（store / backup / 历史导入导出）只认这一层，不关心数据到底在哪儿。
 */
export type { StoredFile } from './localDb.js'
export type { ChatDelta, SessionEventHandlers } from './remoteDb.js'

export const reportStorageError = local.reportStorageError

export const loadSessionSummaries = (): Promise<import('./types.js').SessionSummary[]> =>
  usesRemoteStorage() ? remote.loadSessionSummaries() : local.loadSessionSummaries()

export const loadSession = (id: string): Promise<import('./types.js').Session | undefined> =>
  usesRemoteStorage() ? remote.loadSession(id) : local.loadSession(id)

export const saveSession = (
  session: import('./types.js').Session,
  files: local.StoredFile[] = []
): Promise<void> =>
  usesRemoteStorage() ? remote.saveSession(session, files) : local.saveSession(session, files)

export const renameSession = (id: string, title: string): Promise<void> =>
  usesRemoteStorage() ? remote.renameSession(id, title) : local.renameSession(id, title)

export const deleteSession = (id: string): Promise<void> =>
  usesRemoteStorage() ? remote.deleteSession(id) : local.deleteSession(id)

export const saveFiles = (files: local.StoredFile[]): Promise<void> =>
  usesRemoteStorage() ? remote.saveFiles(files) : local.saveFiles(files)

export const loadFile = (id: string): Promise<Blob | undefined> =>
  usesRemoteStorage() ? remote.loadFile(id) : local.loadFile(id)

// 暂存区始终是本地 IndexedDB（只用于解析过程中的临时数据）
export const clearStaging = local.clearStaging
export const addStagingSession = local.addStagingSession
export const saveStagingFiles = local.saveStagingFiles
export const updateStagingFileTypes = local.updateStagingFileTypes

export const commitStaging = (): Promise<import('./types.js').SessionSummary[]> =>
  usesRemoteStorage() ? remote.commitStaging() : local.commitStaging()

/**
 * 增量同步：把另一台设备对某个会话的改动应用到本地缓存。
 * 返回 applied 表示有新内容；unchanged 表示没有变化；unavailable 表示拿不到增量（需要整份重拉）。
 */
export const syncSession = (session: import('./types.js').Session): Promise<remote.SyncResult> =>
  usesRemoteStorage()
    ? remote.syncSession(session)
    : Promise.resolve({ unavailable: true } as const)

/** 冲突合并后刷新界面（仅后端模式有实际动作） */
export const setMergeListener = remote.setMergeListener

export const applySessionDelta = (
  session: import('./types.js').Session,
  delta: remote.ChatDelta
): import('./types.js').Session | null =>
  usesRemoteStorage() ? remote.applySessionDelta(session, delta) : null

/** 订阅单个会话的实时 SSE 推送（仅后端模式生效） */
export const subscribeSession = (id: string, handlers: remote.SessionEventHandlers): (() => void) =>
  usesRemoteStorage() ? remote.subscribeSession(id, handlers) : () => {}

export const hasSyncedSession = (id: string): boolean =>
  usesRemoteStorage() ? remote.hasSyncedSession(id) : false

export const resetRemoteState = (): void => {
  if (usesRemoteStorage()) {
    remote.resetRemoteState()
  }
}
