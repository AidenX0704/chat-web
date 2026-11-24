import clsx from 'clsx'
import { useEffect, useMemo, useState } from 'react'
import { useIsMobile } from '../../app/viewport.js'
import { useTranslate } from '../../i18n/index.js'
import { getVisibleMessages } from '../../services/chat/branches.js'
import type { Session } from '../../services/chat/types.js'
import { Button } from '../base/Button.js'
import { IconButton } from '../base/IconButton.js'
import { IconCheckOutline16, IconShareOutline16 } from '../base/icons.js'
import { ChatInput } from '../chatInput/ChatInput.js'
import { MessageList } from '../messages/MessageList.js'
import { ShareLinkDialog } from '../share/ShareLinkDialog.js'
import {
  beginShareSelection,
  detachShareSelection,
  endShareSelection,
  setShareMessagesSelected,
  toggleShareMessage,
  useShareSelection,
} from '../share/shareSelectionState.js'
import { MobileHeader } from './MobileHeader.js'
import styles from './SessionView.module.css'

/**
 * 会话页：标题栏（移动端为顶栏）+ 消息列表，输入框吸底。
 *
 * 点「分享」先进入挑消息状态：默认全选，可逐条取消，底部换成「取消 / 创建分享链接」，
 * 点创建分享链接再走一次敏感内容确认弹窗。
 */
export const SessionView = ({
  session,
  streaming,
  siderCollapsed,
}: {
  session: Session
  streaming: boolean
  siderCollapsed: boolean
}) => {
  const t = useTranslate()
  const isMobile = useIsMobile()
  const title = session.title || t('untitledChat')
  const messages = useMemo(() => getVisibleMessages(session), [session])
  const selecting = useShareSelection((state) => state.sessionId === session.id)
  const pendingSessionId = useShareSelection((state) => state.pendingSessionId)
  const selected = useShareSelection((state) => state.selected)
  const [confirming, setConfirming] = useState(false)

  // 从会话列表点的「分享」：会话刚打开，这时才拿得到要分享的消息
  useEffect(() => {
    if (pendingSessionId === session.id) {
      beginShareSelection(
        session.id,
        messages.map((message) => message.id)
      )
    }
  }, [pendingSessionId, session.id, messages])

  // 切走会话就退出挑消息状态：排队中的分享请求要保留，等目标会话打开后再进入
  useEffect(() => detachShareSelection, [])

  // 消息在挑的过程中被删掉时，别把不存在的 id 带进分享请求
  const selectedIds = useMemo(
    () => messages.filter((message) => selected.includes(message.id)).map((message) => message.id),
    [messages, selected]
  )
  const allSelected = messages.length > 0 && selectedIds.length === messages.length

  const startSelection = () =>
    beginShareSelection(
      session.id,
      messages.map((message) => message.id)
    )

  const selectAllToggle = (
    <button
      type="button"
      role="checkbox"
      aria-checked={allSelected}
      className={styles.selectAll}
      onClick={() =>
        setShareMessagesSelected(allSelected ? [] : messages.map((message) => message.id))
      }
    >
      <span className={clsx(styles.selectAllBox, allSelected && styles.selectAllBoxChecked)}>
        {allSelected ? <IconCheckOutline16 /> : null}
      </span>
      {t('shareSelectAll')}
    </button>
  )

  return (
    <div className={styles.view}>
      {isMobile ? (
        <MobileHeader
          title={selecting ? t('shareSelectCount', { count: selectedIds.length }) : title}
          action={selecting ? selectAllToggle : undefined}
        />
      ) : (
        <div className={styles.header}>
          {selecting ? (
            <div className={styles.shareHeader}>
              {selectAllToggle}
              <span className={styles.shareCount}>
                {t('shareSelectCount', { count: selectedIds.length })}
              </span>
            </div>
          ) : (
            <>
              <div className={clsx(styles.title, siderCollapsed && styles.withCollapsedSider)}>
                {title}
              </div>
              <IconButton
                className={styles.shareButton}
                icon={<IconShareOutline16 />}
                tooltip={t('sessionItemMenuShareOption')}
                tooltipPlacement="bottom"
                onClick={startSelection}
              />
            </>
          )}
        </div>
      )}
      <MessageList
        session={session}
        streaming={streaming}
        selection={
          selecting ? { selected: new Set(selectedIds), onToggle: toggleShareMessage } : undefined
        }
        footer={
          selecting ? null : (
            <div className={styles.inputContainer}>
              <ChatInput sessionId={session.id} />
              <div className={styles.caveat}>{t('contentCaveat')}</div>
            </div>
          )
        }
      />
      {selecting ? (
        <div className={styles.shareBar}>
          <div className={styles.shareBarInner}>
            <Button variant="outlined" onClick={endShareSelection}>
              {t('cancel')}
            </Button>
            <Button disabled={selectedIds.length === 0} onClick={() => setConfirming(true)}>
              {t('shareCreateLink')}
            </Button>
          </div>
        </div>
      ) : null}
      {selecting && confirming ? (
        <ShareLinkDialog
          session={session}
          messageIds={allSelected ? null : selectedIds}
          onClose={(created) => {
            setConfirming(false)
            // 生成成功后结束整个流程；只是取消确认时保留勾选，方便继续调整
            if (created) {
              endShareSelection()
            }
          }}
        />
      ) : null}
    </div>
  )
}
