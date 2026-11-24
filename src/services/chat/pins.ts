import { create } from 'zustand'

/**
 * 会话置顶。
 *
 * 置顶是「这台设备怎么看列表」的偏好，不属于会话内容本身，因此不写进会话数据：
 * 接入后端时正文与标题多端共享，而置顶状态只存本机 localStorage（与会话 ID 列表对应）。
 * 会话被删除后残留的 ID 在渲染时按现有列表过滤，不影响显示。
 */
const STORAGE_KEY = 'chat-personal:pinned-sessions'

const readPinned = (): string[] => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    const parsed: unknown = raw === null ? null : (JSON.parse(raw) as unknown)
    if (!Array.isArray(parsed)) {
      return []
    }
    return parsed.filter((id): id is string => typeof id === 'string')
  } catch {
    return []
  }
}

const writePinned = (ids: string[]) => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(ids))
  } catch {
    // 存储不可用时只在内存中生效
  }
}

export const usePinnedSessions = create<{ ids: string[] }>(() => ({ ids: readPinned() }))

/** 批量置顶或取消置顶；选中的会话可能一半已置顶，统一按目标状态写入。 */
export const setSessionsPinned = (ids: string[], pinned: boolean) => {
  const next = new Set(usePinnedSessions.getState().ids)
  for (const id of ids) {
    if (pinned) {
      next.add(id)
    } else {
      next.delete(id)
    }
  }
  const list = [...next]
  writePinned(list)
  usePinnedSessions.setState({ ids: list })
}
