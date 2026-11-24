import clsx from 'clsx'
import brandMark from '../../assets/brand-mark.png'
import styles from './BrandMark.module.css'

export type BrandMarkSize = 'sider' | 'login' | 'welcome'

/** chat-web 品牌标识：图标 + 双色渐变现代感字标 */
export const BrandMark = ({
  size = 'sider',
  /** 只显示图标：收起后的侧边栏只剩一条窄栏，放不下字标 */
  iconOnly = false,
  className,
}: {
  size?: BrandMarkSize
  iconOnly?: boolean
  className?: string
}) => (
  <span
    className={clsx(styles.brand, styles[size], iconOnly && styles.iconOnly, className)}
    aria-label="chat-web"
  >
    <span className={styles.iconWrap} aria-hidden="true">
      <img src={brandMark} alt="" className={styles.icon} draggable={false} decoding="async" />
    </span>
    <span className={styles.wordmark} aria-hidden="true">
      <span className={styles.wordPrimary}>chat</span>
      <span className={styles.wordAccent}>-web</span>
    </span>
  </span>
)
