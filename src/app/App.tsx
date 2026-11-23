import clsx from 'clsx'
import { useEffect } from 'react'
import { useTranslate } from '../i18n/index.js'
import { useSettings } from '../services/settings.js'
import { closeLogin, initAuth, useAuth } from '../services/auth/store.js'
import { isBackendMode } from '../services/auth/session.js'
import { refreshGuestQuota } from '../services/guest/quota.js'
import { AuthLoadingView, LoginView } from '../components/auth/LoginView.js'
import { useIsMobile, useMobileViewport, usePreventPageScroll } from './viewport.js'
import {
  bindChatPersistence,
  bindSessionSync,
  initChat,
  resetChatStore,
  retrySaveSessions,
  selectSession,
  useChatStore,
} from '../services/chat/store.js'
import { SearchPanel } from '../components/search/SearchPanel.js'
import { closeSearchPanel } from '../components/search/searchPanelState.js'
import { FilePreviewModal } from '../components/files/FilePreviewModal.js'
import { closeFilePreview } from '../components/files/filePreviewState.js'
import { AdminConsoleModal } from '../components/admin/AdminConsoleModal.js'
import { SharedSessionView } from '../components/share/SharedSessionView.js'
import { readShareToken } from '../services/chat/share.js'
import { SessionView } from '../components/session/SessionView.js'
import { MobileHeader } from '../components/session/MobileHeader.js'
import { Welcome } from '../components/session/Welcome.js'
import { ensureApiKey } from '../components/settings/settingsDialogState.js'
import { SettingsDialog } from '../components/settings/SettingsDialog.js'
import { Toast } from '../components/base/Toast.js'
import { showToast } from '../components/base/toastState.js'
import { onUploadNotice } from '../services/attachments.js'
import { Button } from '../components/base/Button.js'
import { stopReadAloud } from '../services/speech/readAloud.js'
import { CollapsedSider } from '../components/sider/CollapsedSider.js'
import { closeMobileSider } from '../components/sider/mobileSiderState.js'
import { MobileSider, Sider } from '../components/sider/Sider.js'
import styles from './App.module.css'

/**
 * 分享链接是公开路由（/s/<token>）：直接渲染只读页面，
 * 不初始化登录态、不加载本地会话，任何人拿到链接就能看。
 * 路由在模块加载时解析一次：整页只有这一个入口，无需跟随地址变化。
 */
const SHARE_TOKEN = readShareToken(window.location.pathname)

export const App = () =>
  SHARE_TOKEN === null ? <ChatRoot /> : <SharedSessionView token={SHARE_TOKEN} />

/**
 * 应用入口：接入后端时先确认登录态。
 * 未登录也能直接开聊（按 IP 每天有固定次数的免费额度），
 * 会话存在本机；点侧边栏的「登录」才切到登录页，登录后换成服务端历史。
 */
const ChatRoot = () => {
  const status = useAuth((state) => state.status)
  const loginPrompt = useAuth((state) => state.loginPrompt)

  useEffect(() => {
    void initAuth()
  }, [])

  if (!isBackendMode) {
    return <ChatApp />
  }
  if (status === 'unknown') {
    return <AuthLoadingView />
  }
  if (status === 'authenticated') {
    // 登录前后存储位置不同（本机 / 服务端），用 key 强制重建，避免串数据
    return <ChatApp key="signed-in" />
  }
  if (loginPrompt) {
    return <LoginView onDismiss={closeLogin} />
  }
  return <ChatApp key="guest" />
}

/** 登录后（或纯静态部署下）的聊天界面 */
const ChatApp = () => {
  const t = useTranslate()
  const isMobile = useIsMobile()
  const signedIn = useAuth((state) => state.status === 'authenticated')
  /** 访客：接入后端但未登录，只能对话且次数有限 */
  const guest = isBackendMode && !signedIn
  const locale = useSettings((state) => state.locale)
  // 移动端侧边栏以独立抽屉管理开合状态
  const siderCollapsed = useSettings((state) => state.siderCollapsed) && !isMobile
  const ready = useChatStore((state) => state.ready)
  const initError = useChatStore((state) => state.initError)
  const saveError = useChatStore((state) => Object.values(state.sessionSaveErrors).some(Boolean))
  const importingHistory = useChatStore((state) => state.importingHistory)
  const session = useChatStore((state) =>
    state.activeId !== null && Object.hasOwn(state.sessionCache, state.activeId)
      ? state.sessionCache[state.activeId]
      : undefined
  )
  const sessionLoadError = useChatStore((state) =>
    state.activeId === null ? false : state.sessionLoadErrors[state.activeId] === true
  )
  const frameRef = useMobileViewport(isMobile)
  const streaming = useChatStore((state) =>
    state.activeId === null ? false : Object.hasOwn(state.streaming, state.activeId)
  )
  const activeId = useChatStore((state) => state.activeId)

  usePreventPageScroll(isMobile)

  useEffect(() => {
    document.documentElement.lang = locale
  }, [locale])

  // 文件数、存储空间达到上限时，附件上只显示「上传失败」，原因用 toast 说明
  useEffect(() => onUploadNotice(showToast), [])
  useEffect(bindChatPersistence, [])
  // 多端同步：切回页面或定时拉取其他设备产生的更新
  useEffect(bindSessionSync, [])

  // 搜索结果面板与附件预览只属于当前会话
  useEffect(closeSearchPanel, [activeId])
  useEffect(closeFilePreview, [activeId])
  // 切换会话时停止朗读
  useEffect(stopReadAloud, [activeId])
  // 移动端选中会话、切换布局后收起抽屉
  useEffect(closeMobileSider, [activeId, isMobile])

  // 访客进来先问一次「今天还剩几次」，侧边栏因此能直接显示剩余额度
  useEffect(() => {
    if (guest) {
      void refreshGuestQuota()
    }
  }, [guest])

  useEffect(() => {
    void initChat()
    // 首次打开先在设置里输入 API Key
    ensureApiKey()
    return () => {
      if (isBackendMode) {
        resetChatStore()
      }
    }
  }, [])

  return (
    <>
      <div ref={frameRef} className={styles.frame}>
        {isMobile ? (
          <MobileSider />
        ) : (
          // 收起的侧边栏保留挂载，靠宽度过渡做动画，收起时只剩左上角的按钮组
          <div className={clsx(styles.siderSlot, siderCollapsed && styles.siderSlotCollapsed)}>
            <Sider />
          </div>
        )}
        <main className={styles.main}>
          {saveError ? (
            <div className={styles.saveError} role="alert">
              <span>{t('sessionSaveFailed')}</span>
              <Button
                variant="outlined"
                size="s"
                disabled={importingHistory}
                onClick={retrySaveSessions}
              >
                {t('retry')}
              </Button>
            </div>
          ) : null}
          <div className={styles.content}>
            {siderCollapsed ? <CollapsedSider /> : null}
            {!ready || (activeId !== null && !session) ? (
              <div className={styles.loadingView}>
                {isMobile ? <MobileHeader /> : null}
                <div className={styles.loadingState} role="status" aria-live="polite">
                  <span>
                    {(!ready ? initError : sessionLoadError)
                      ? t(!ready ? 'sessionListLoadFailed' : 'sessionLoadFailed')
                      : t('sessionLoading')}
                  </span>
                  {(!ready ? initError : sessionLoadError) ? (
                    <Button
                      variant="outlined"
                      size="m"
                      onClick={() => {
                        if (!ready) {
                          void initChat()
                        } else if (activeId !== null) {
                          selectSession(activeId)
                        }
                      }}
                    >
                      {t('retry')}
                    </Button>
                  ) : null}
                </div>
              </div>
            ) : session ? (
              <SessionView
                session={session}
                streaming={streaming}
                siderCollapsed={siderCollapsed}
              />
            ) : (
              <Welcome />
            )}
          </div>
        </main>
        <SearchPanel />
      </div>
      <SettingsDialog />
      {isBackendMode && signedIn ? <AdminConsoleModal /> : null}
      <FilePreviewModal />
      <Toast />
    </>
  )
}
