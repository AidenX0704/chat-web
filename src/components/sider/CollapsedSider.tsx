import { IconPanelLeftOutline16, NewChatIcon } from '../base/icons.js'
import { useTranslate } from '../../i18n/index.js'
import { setSiderCollapsed } from '../../services/settings.js'
import { newChat } from '../../services/chat/store.js'
import { BrandMark } from '../base/BrandMark.js'
import { IconButton } from '../base/IconButton.js'
import styles from './Sider.module.css'

/** 收起后左上角：品牌标识在最左上方，下面跟展开 / 新对话按钮 */
export const CollapsedSider = () => {
  const t = useTranslate()
  return (
    <div className={styles.collapsed}>
      <button
        type="button"
        className={styles.collapsedBrand}
        aria-label={t('appName')}
        onClick={() => setSiderCollapsed(false)}
      >
        <BrandMark size="sider" iconOnly />
      </button>
      <div className={styles.collapsedGroup}>
        <IconButton
          size="m"
          tone="primary"
          icon={<IconPanelLeftOutline16 />}
          tooltip={t('expandSiderbarButton')}
          onClick={() => setSiderCollapsed(false)}
        />
        <IconButton
          size="m"
          tone="primary"
          icon={<NewChatIcon />}
          tooltip={t('newChat')}
          onClick={newChat}
        />
      </div>
    </div>
  )
}
