import clsx from 'clsx'
import { memo, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import {
  IconCheckOutline16,
  IconEditOutline16,
  IconEllipsisOutline16,
  IconPinTopOutline16,
  IconShareOutline16,
  IconTrashOutline16,
} from '../base/icons.js'
import { setSessionsPinned } from '../../services/chat/pins.js'
import { requestShareSession } from '../share/shareSelectionState.js'
import { renameSession, selectSession } from '../../services/chat/store.js'
import type { SessionSummary } from '../../services/chat/types.js'
import { IconButton } from '../base/IconButton.js'
import { Menu } from '../base/Menu.js'
import { closeMobileSider } from './mobileSiderState.js'
import styles from './SessionItem.module.css'

export const SessionItem = memo(function SessionItem({
  session,
  active,
  pinned,
  selectionMode = false,
  selected = false,
  onToggleSelect,
  onDelete,
}: {
  session: SessionSummary
  active: boolean
  pinned: boolean
  /** 多选模式：整行变成勾选项，不再显示「更多」菜单 */
  selectionMode?: boolean
  selected?: boolean
  onToggleSelect?: () => void
  onDelete: () => void
}) {
  const t = useTranslate()
  const [editing, setEditing] = useState(false)
  // 菜单开着时保持「更多」按钮可见：触发元素被隐藏后浮层会失去锚点
  const [menuOpen, setMenuOpen] = useState(false)
  const displayTitle = session.title || t('untitledChat')

  if (editing) {
    const finish = (title: string) => {
      setEditing(false)
      if (title.trim() && title.trim() !== displayTitle) {
        renameSession(session.id, title.trim())
      }
    }
    return (
      <input
        className={styles.renameInput}
        defaultValue={displayTitle}
        autoFocus
        onFocus={(event) => event.target.select()}
        onBlur={(event) => finish(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
            finish(event.currentTarget.value)
          } else if (event.key === 'Escape') {
            setEditing(false)
          }
        }}
      />
    )
  }

  return (
    <div
      className={clsx(
        styles.item,
        active && !selectionMode && styles.active,
        selectionMode && styles.selectable,
        selectionMode && selected && styles.selected,
        menuOpen && styles.menuOpen
      )}
      onClick={() => {
        if (selectionMode) {
          onToggleSelect?.()
          return
        }
        selectSession(session.id)
        closeMobileSider()
      }}
    >
      {selectionMode ? (
        <span className={clsx(styles.checkbox, selected && styles.checkboxChecked)}>
          {selected ? <IconCheckOutline16 /> : null}
        </span>
      ) : null}
      <div className={styles.title}>{displayTitle}</div>
      {selectionMode ? null : (
        <div className={styles.action} onClick={(event) => event.stopPropagation()}>
          <Menu
            onOpenChange={setMenuOpen}
            options={[
              {
                key: 'rename',
                label: t('sessionItemMenuRenameOption'),
                icon: <IconEditOutline16 />,
                onSelect: () => setEditing(true),
              },
              {
                key: 'pin',
                label: pinned ? t('sessionItemMenuUnpinOption') : t('sessionItemMenuPinOption'),
                icon: <IconPinTopOutline16 />,
                onSelect: () => setSessionsPinned([session.id], !pinned),
              },
              {
                key: 'share',
                label: t('sessionItemMenuShareOption'),
                icon: <IconShareOutline16 />,
                // 分享先打开会话并进入挑消息状态，真正生成链接在会话里完成
                onSelect: () => {
                  selectSession(session.id)
                  requestShareSession(session.id)
                  closeMobileSider()
                },
              },
              {
                key: 'delete',
                label: t('delete'),
                icon: <IconTrashOutline16 />,
                danger: true,
                onSelect: onDelete,
              },
            ]}
          >
            {({ toggle }) => (
              <IconButton
                icon={<IconEllipsisOutline16 />}
                aria-label={t('more')}
                onClick={toggle}
              />
            )}
          </Menu>
        </div>
      )}
    </div>
  )
})
