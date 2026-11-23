import { useIsMobile } from '../../app/viewport.js'
import { useTranslate } from '../../i18n/index.js'
import { isBackendMode } from '../../services/auth/session.js'
import { openLogin, useAuth } from '../../services/auth/store.js'
import { useGuestQuota } from '../../services/guest/quota.js'
import { BrandMark } from '../base/BrandMark.js'
import { ChatInput } from '../chatInput/ChatInput.js'
import { MobileHeader } from './MobileHeader.js'
import styles from './Welcome.module.css'

/** 新对话：品牌标识 + 问候语 + 输入框。桌面端居中；移动端输入框吸底 */
export const Welcome = () => {
  const t = useTranslate()
  const isMobile = useIsMobile()
  // 未登录的访客在输入框下方看到今日剩余次数
  const guest = isBackendMode && useAuth((state) => state.status === 'anonymous')
  return (
    <div className={styles.container}>
      {isMobile ? <MobileHeader /> : null}
      <div className={styles.welcome}>
        <div className={styles.hero}>
          <BrandMark size="welcome" />
          <div className={styles.greeting}>{t('welcomeMessageChat250808')}</div>
        </div>
        <ChatInput sessionId={null} />
        {guest ? <GuestNotice /> : null}
        {isMobile ? <div className={styles.caveat}>{t('contentCaveat')}</div> : null}
      </div>
    </div>
  )
}

/** 访客行：今天还剩几次免费对话，点「登录」切到登录页 */
const GuestNotice = () => {
  const t = useTranslate()
  const quota = useGuestQuota((state) => state.quota)
  return (
    <div className={styles.guest}>
      <span>
        {quota === null
          ? t('guestQuotaLoading')
          : quota.remaining > 0
            ? t('guestQuotaRemaining', { remaining: quota.remaining, limit: quota.limit })
            : t('guestQuotaExhausted')}
      </span>
      <button type="button" className={styles.guestLogin} onClick={openLogin}>
        {t('guestLogin')}
      </button>
    </div>
  )
}
