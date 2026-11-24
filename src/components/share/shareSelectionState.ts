import { create } from 'zustand'

/**
 * 分享前的选消息状态。
 *
 * 点分享不会立刻生成链接，而是先让会话进入「挑消息」状态：默认全选，
 * 可以逐条取消（比如某条消息里有隐私内容），再点底部「创建分享链接」二次确认。
 */
type ShareSelectionState = {
  /** 正在挑消息的会话；null 表示不在选择状态 */
  sessionId: string | null
  /** 从会话列表点「分享」时目标会话可能还没打开，先记下来，等会话加载后进入选择状态 */
  pendingSessionId: string | null
  /** 已选中的消息 id，顺序不代表展示顺序 */
  selected: string[]
}

export const useShareSelection = create<ShareSelectionState>(() => ({
  sessionId: null,
  pendingSessionId: null,
  selected: [],
}))

/** 从会话列表发起分享：把请求排到目标会话打开之后 */
export const requestShareSession = (sessionId: string) =>
  useShareSelection.setState({ pendingSessionId: sessionId })

/** 会话已打开：默认选中全部消息 */
export const beginShareSelection = (sessionId: string, messageIds: string[]) =>
  useShareSelection.setState({ sessionId, pendingSessionId: null, selected: messageIds })

export const toggleShareMessage = (id: string) =>
  useShareSelection.setState((state) => ({
    selected: state.selected.includes(id)
      ? state.selected.filter((item) => item !== id)
      : [...state.selected, id],
  }))

/** 全选 / 取消全选：messageIds 为空表示全部取消 */
export const setShareMessagesSelected = (messageIds: string[]) =>
  useShareSelection.setState({ selected: messageIds })

/** 退出选择状态，丢弃已选的勾选 */
export const endShareSelection = () =>
  useShareSelection.setState({ sessionId: null, pendingSessionId: null, selected: [] })

/**
 * 仅退出当前会话的选择状态：切换会话时用，不清掉排队中的分享请求，
 * 否则从会话列表点「分享」就会在打开新会话的瞬间被清空。
 */
export const detachShareSelection = () =>
  useShareSelection.setState({ sessionId: null, selected: [] })
