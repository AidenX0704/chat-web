import clsx from 'clsx'
import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslate } from '../../i18n/index.js'
import {
  IconChecklistOutline16,
  IconDataOutline16,
  IconEllipsisOutline16,
  IconPanelLeftOutline16,
  IconSearchOutline16,
  IconSettingsOutline16,
  NewChatIcon,
} from '../base/icons.js'
import { setSiderCollapsed } from '../../services/settings.js'
import { isBackendMode } from '../../services/auth/session.js'
import { logout, openLogin, useAuth } from '../../services/auth/store.js'
import { useGuestQuota } from '../../services/guest/quota.js'
import { groupSessions } from '../../services/chat/sessionGroups.js'
import { setSessionsPinned, usePinnedSessions } from '../../services/chat/pins.js'
import { newChat, removeSession, useChatStore } from '../../services/chat/store.js'
import { useAnchoredPosition, useDismiss } from '../base/anchored.js'
import { BrandMark } from '../base/BrandMark.js'
import { Button } from '../base/Button.js'
import { IconButton } from '../base/IconButton.js'
import { Modal } from '../base/Modal.js'
import { showToast } from '../base/toastState.js'
import { openAdminConsole } from '../admin/adminConsoleState.js'
import { openSettings } from '../settings/settingsDialogState.js'
import { closeMobileSider, useMobileSider } from './mobileSiderState.js'
import { SessionItem } from './SessionItem.js'
import { SessionSearch } from './SessionSearch.js'
import styles from './Sider.module.css'

/** 停止滚动后滚动条继续显示多久（毫秒） */
const SCROLLBAR_FADE_MS = 800

/**
 * 展开的侧边栏：名称与搜索 / 多选 / 收起按钮、开启新对话、按时间分组的会话列表（置顶单独成组）、
 * 底部设置；多选时底部换成批量置顶与删除。移动端放在抽屉里，收起按钮关闭抽屉。
 */
export const Sider = ({ mobile = false }: { mobile?: boolean }) => {
  const t = useTranslate()
  const sessions = useChatStore((state) => state.sessions)
  const activeId = useChatStore((state) => state.activeId)
  // 未登录的访客在底部显示剩余额度与登录入口；已登录的唯一管理员展示头像与用户名卡片入口
  const authStatus = useAuth((state) => state.status)
  const authUser = useAuth((state) => state.user)
  const guest = isBackendMode && authStatus === 'anonymous'
  const isAdmin = isBackendMode && authStatus === 'authenticated'
  const pinnedIds = usePinnedSessions((state) => state.ids)
  const [now, setNow] = useState(Date.now)
  const [searchOpen, setSearchOpen] = useState(false)
  const [selectionMode, setSelectionMode] = useState(false)
  const [selected, setSelected] = useState<string[]>([])
  const [deletingIds, setDeletingIds] = useState<string[] | null>(null)
  const [deletePending, setDeletePending] = useState(false)
  /** 会话列表是否正在滚动：滚动期间才显示滚动条，停下后自动隐藏 */
  const [scrolling, setScrolling] = useState(false)
  const scrollTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const onListScroll = () => {
    setScrolling(true)
    if (scrollTimer.current !== null) {
      clearTimeout(scrollTimer.current)
    }
    scrollTimer.current = setTimeout(() => {
      scrollTimer.current = null
      setScrolling(false)
    }, SCROLLBAR_FADE_MS)
  }

  useEffect(
    () => () => {
      if (scrollTimer.current !== null) {
        clearTimeout(scrollTimer.current)
      }
    },
    []
  )

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>
    const refresh = () => {
      clearTimeout(timer)
      const time = Date.now()
      setNow(time)
      const midnight = new Date(time).setHours(24, 0, 0, 0)
      timer = setTimeout(refresh, midnight - time)
    }
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        refresh()
      }
    }
    refresh()
    document.addEventListener('visibilitychange', onVisibilityChange)
    window.addEventListener('focus', refresh)
    return () => {
      clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisibilityChange)
      window.removeEventListener('focus', refresh)
    }
  }, [])

  const pinned = useMemo(() => new Set(pinnedIds), [pinnedIds])
  const groups = useMemo(() => {
    const pinnedSessions = sessions.filter((session) => pinned.has(session.id))
    const rest = sessions.filter((session) => !pinned.has(session.id))
    return [
      ...(pinnedSessions.length > 0
        ? [{ key: 'pinned', label: t('pinnedSessionsSectionTitle'), sessions: pinnedSessions }]
        : []),
      ...groupSessions(rest, now, t),
    ]
  }, [sessions, now, t, pinned])

  // 会话被删除或切换账号后，把已经不存在的 ID 从多选里摘掉
  useEffect(() => {
    setSelected((current) => {
      const alive = new Set(sessions.map((session) => session.id))
      const next = current.filter((id) => alive.has(id))
      return next.length === current.length ? current : next
    })
  }, [sessions])

  const exitSelectionMode = () => {
    setSelectionMode(false)
    setSelected([])
  }

  const toggleSelected = (id: string) =>
    setSelected((current) =>
      current.includes(id) ? current.filter((item) => item !== id) : [...current, id]
    )

  const allSelected = sessions.length > 0 && selected.length === sessions.length
  // 选中的会话全都已置顶时，按钮改成「取消置顶」
  const unpinSelected = selected.length > 0 && selected.every((id) => pinned.has(id))

  const deleteSelected = async () => {
    setDeletePending(true)
    let failed = false
    try {
      for (const id of deletingIds ?? []) {
        if (!(await removeSession(id))) {
          failed = true
        }
      }
    } finally {
      setDeletePending(false)
      setDeletingIds(null)
    }
    if (failed) {
      showToast({ key: 'sessionDeleteFailed', type: 'error' })
    } else {
      exitSelectionMode()
    }
  }

  return (
    <div className={clsx(styles.sider, mobile && styles.mobile)}>
      <div className={styles.top}>
        <button
          type="button"
          className={styles.appName}
          aria-label={t('appName')}
          onClick={() => {
            newChat()
            closeMobileSider()
          }}
        >
          <BrandMark size="sider" />
        </button>
        <div className={styles.topActions}>
          <IconButton
            size="m"
            icon={<IconSearchOutline16 />}
            tooltip={t('searchConversationsButton')}
            tooltipPlacement="bottom"
            onClick={() => setSearchOpen(true)}
          />
          <IconButton
            size="m"
            icon={<IconPanelLeftOutline16 />}
            tooltip={t('collapseSiderbarButton')}
            tooltipPlacement="bottom"
            onClick={() => (mobile ? closeMobileSider() : setSiderCollapsed(true))}
          />
        </div>
      </div>
      <div className={styles.newChatRow}>
        <button
          type="button"
          className={styles.newChat}
          onClick={() => {
            newChat()
            closeMobileSider()
            exitSelectionMode()
          }}
        >
          <span className={styles.newChatIcon}>
            <NewChatIcon />
          </span>
          {t('newChat')}
        </button>
        <IconButton
          size="m"
          icon={<IconChecklistOutline16 />}
          tooltip={t('selectSessionsButton')}
          tooltipPlacement="bottom"
          onClick={() => setSelectionMode(true)}
        />
      </div>
      <div className={styles.listWrap}>
        <div
          className={clsx(styles.list, scrolling && styles.listScrolling)}
          onScroll={onListScroll}
        >
          {groups.map((group) => (
            <div key={group.key} className={styles.section}>
              <div className={styles.sectionHeader}>{group.label}</div>
              {group.sessions.map((session) => (
                <SessionItem
                  key={session.id}
                  session={session}
                  active={session.id === activeId}
                  pinned={pinned.has(session.id)}
                  selectionMode={selectionMode}
                  selected={selected.includes(session.id)}
                  onToggleSelect={() => toggleSelected(session.id)}
                  onDelete={() => setDeletingIds([session.id])}
                />
              ))}
            </div>
          ))}
        </div>
      </div>
      {guest ? <GuestFooter /> : null}
      <div className={clsx(styles.bottom, selectionMode && styles.bottomSelectMode)}>
        {selectionMode ? (
          <>
            <div className={styles.selectionInfo}>
              <span>{t('selectedSessionsCount', { count: selected.length })}</span>
              <button
                type="button"
                className={styles.selectAll}
                onClick={() =>
                  setSelected(allSelected ? [] : sessions.map((session) => session.id))
                }
              >
                {allSelected ? t('deselectAllSessions') : t('selectAllSessions')}
              </button>
            </div>
            <div className={styles.selectionActions}>
              <Button
                size="s"
                variant="outlined"
                disabled={selected.length === 0}
                onClick={() => {
                  setSessionsPinned(selected, !unpinSelected)
                  exitSelectionMode()
                }}
              >
                {unpinSelected ? t('sessionItemMenuUnpinOption') : t('sessionItemMenuPinOption')}
              </Button>
              <Button
                size="s"
                variant="dangerOutlined"
                disabled={selected.length === 0}
                onClick={() => setDeletingIds(selected)}
              >
                {t('delete')}
              </Button>
              <Button size="s" variant="outlined" onClick={exitSelectionMode}>
                {t('cancel')}
              </Button>
            </div>
          </>
        ) : isAdmin ? (
          <AdminProfileMenu
            username={authUser?.username ?? t('adminRoleBadge')}
            avatar={authUser?.avatar ?? null}
          />
        ) : (
          <button type="button" className={styles.settings} onClick={() => openSettings('general')}>
            <span className={styles.settingsIcon}>
              <IconSettingsOutline16 />
            </span>
            <span className={styles.settingsLabel}>{t('settings')}</span>
          </button>
        )}
      </div>
      {searchOpen ? <SessionSearch onClose={() => setSearchOpen(false)} /> : null}
      {deletingIds ? (
        <Modal
          title={
            deletingIds.length > 1
              ? t('deleteSelectedSessionsModalTitle')
              : t('deleteSessionModalContentTitle')
          }
          onClose={() => {
            if (!deletePending) {
              setDeletingIds(null)
            }
          }}
          footer={
            <>
              <Button
                variant="outlined"
                disabled={deletePending}
                onClick={() => setDeletingIds(null)}
              >
                {t('cancel')}
              </Button>
              <Button
                variant="danger"
                disabled={deletePending}
                onClick={() => void deleteSelected()}
              >
                {t('delete')}
              </Button>
            </>
          }
        >
          {deletingIds.length > 1
            ? t('deleteSelectedSessionsDescription', { count: deletingIds.length })
            : t('deleteSessionWithFilesDescription')}
        </Modal>
      ) : null}
    </div>
  )
}

const getAvatarInitial = (name: string): string => {
  const trimmed = name.trim()
  if (!trimmed) {
    return 'A'
  }
  return Array.from(trimmed)[0]?.toUpperCase() ?? 'A'
}

const IconLogoutOutline16 = () => (
  <svg width={16} height={16} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path
      d="M6.25 2.25H3.75C2.92157 2.25 2.25 2.92157 2.25 3.75V12.25C2.25 13.0784 2.92157 13.75 3.75 13.75H6.25M10.75 11.25L13.75 8L10.75 4.75M13.5 8H6"
      stroke="currentColor"
      strokeWidth={1.4}
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
)

/**
 * 管理员账号底部入口：展示头像与用户名，点击后在上方弹出精致浮层卡片，
 * 收纳「管理后台」「设置」与「退出登录」。
 */
const AdminProfileMenu = ({
  username,
  avatar,
}: {
  username: string
  avatar: string | null
}) => {
  const t = useTranslate()
  const [open, setOpen] = useState(false)
  const initial = getAvatarInitial(username)
  const { anchorRef, floatingRef, position } = useAnchoredPosition<
    HTMLButtonElement,
    HTMLDivElement
  >(open, { side: 'top', align: 'start', offset: 8 })
  useDismiss(open, [anchorRef, floatingRef], () => setOpen(false))

  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        className={clsx(styles.profileTrigger, open && styles.profileTriggerOpen)}
        onClick={() => setOpen((value) => !value)}
      >
        <span className={clsx(styles.avatar, avatar && styles.avatarCustom)} aria-hidden>
          {avatar ? <img src={avatar} alt={username} className={styles.avatarImg} /> : initial}
        </span>
        <span className={styles.profileInfo}>
          <span className={styles.profileName}>{username}</span>
          <span className={styles.profileRole}>{t('adminRoleBadge')}</span>
        </span>
        <span className={styles.profileMore} aria-hidden>
          <IconEllipsisOutline16 />
        </span>
      </button>
      {open
        ? createPortal(
            <div
              ref={floatingRef}
              role="menu"
              className={styles.profileCard}
              style={position ?? { top: 0, left: 0, visibility: 'hidden' }}
            >
              <div className={styles.profileCardHeader}>
                <span
                  className={clsx(styles.avatar, styles.avatarSm, avatar && styles.avatarCustom)}
                  aria-hidden
                >
                  {avatar ? (
                    <img src={avatar} alt={username} className={styles.avatarImg} />
                  ) : (
                    initial
                  )}
                </span>
                <div className={styles.profileCardIdentity}>
                  <span className={styles.profileCardName}>{username}</span>
                  <span className={styles.profileCardBadge}>{t('adminRoleBadge')}</span>
                </div>
              </div>
              <div className={styles.profileDivider} />
              <button
                type="button"
                role="menuitem"
                className={styles.profileOption}
                onClick={() => {
                  setOpen(false)
                  closeMobileSider()
                  openAdminConsole('policy')
                }}
              >
                <span className={styles.profileOptionIcon}>
                  <IconDataOutline16 />
                </span>
                <span>{t('adminConsole')}</span>
              </button>
              <button
                type="button"
                role="menuitem"
                className={styles.profileOption}
                onClick={() => {
                  setOpen(false)
                  closeMobileSider()
                  openSettings('general')
                }}
              >
                <span className={styles.profileOptionIcon}>
                  <IconSettingsOutline16 />
                </span>
                <span>{t('settings')}</span>
              </button>
              <div className={styles.profileDivider} />
              <button
                type="button"
                role="menuitem"
                className={clsx(styles.profileOption, styles.profileOptionDanger)}
                onClick={() => {
                  setOpen(false)
                  closeMobileSider()
                  void logout()
                }}
              >
                <span className={styles.profileOptionIcon}>
                  <IconLogoutOutline16 />
                </span>
                <span>{t('accountLogout')}</span>
              </button>
            </div>,
            document.body
          )
        : null}
    </>
  )
}

/**
 * 访客行：未登录时可以先用每天的免费次数对话，
 * 这里显示还剩几次，并给出登录入口。
 */
const GuestFooter = () => {
  const t = useTranslate()
  const quota = useGuestQuota((state) => state.quota)
  return (
    <div className={styles.guest}>
      <div className={styles.guestText}>
        <div className={styles.guestTitle}>{t('guestModeTitle')}</div>
        <div className={styles.guestHint}>
          {quota === null
            ? t('guestQuotaLoading')
            : !quota.enabled
              ? t('guestDisabled')
              : quota.blocked
                ? t('guestIpBlocked')
                : quota.remaining > 0
                  ? t('guestQuotaRemaining', { remaining: quota.remaining, limit: quota.limit })
                  : t('guestQuotaExhausted')}
        </div>
      </div>
      <Button size="s" variant="outlined" onClick={openLogin}>
        {t('guestLogin')}
      </Button>
    </div>
  )
}

/** 移动端抽屉：浮在页面上方，点空白区域关闭。 */
export const MobileSider = () => {
  const open = useMobileSider((state) => state.open)
  if (!open) {
    return null
  }
  return (
    <>
      <div className={styles.drawerMask} onClick={closeMobileSider} />
      <div className={styles.drawer}>
        <Sider mobile />
      </div>
    </>
  )
}
