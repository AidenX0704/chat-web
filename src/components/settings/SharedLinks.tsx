import clsx from 'clsx'
import { useCallback, useEffect, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { listSharedLinks, revokeSharedLink, type SharedLink } from '../../services/chat/share.js'
import { formatDate } from '../../utils/format.js'
import { copyText } from '../../utils/clipboard.js'
import { Button } from '../base/Button.js'
import { Modal } from '../base/Modal.js'
import { showToast } from '../base/toastState.js'
import styles from './Settings.module.css'
import listStyles from './SharedLinks.module.css'

/**
 * 数据管理里的「被分享的链接」：列出当前账号仍在生效的分享，
 * 可以复制链接，或随时取消（取消后原链接立即失效）。
 */
export const SharedLinks = () => {
  const t = useTranslate()
  const [open, setOpen] = useState(false)
  /** null 表示还没加载出来 */
  const [links, setLinks] = useState<SharedLink[] | null>(null)
  const [failed, setFailed] = useState(false)
  const [busyToken, setBusyToken] = useState<string | null>(null)

  const reload = useCallback(async () => {
    setFailed(false)
    setLinks(null)
    try {
      setLinks(await listSharedLinks())
    } catch {
      setFailed(true)
      setLinks([])
    }
  }, [])

  useEffect(() => {
    if (open) {
      void reload()
    }
  }, [open, reload])

  const copy = async (url: string) => {
    const copied = await copyText(url)
    showToast(copied ? { key: 'shareManageCopied' } : { key: 'sessionShareFailed', type: 'error' })
  }

  const revoke = async (link: SharedLink) => {
    setBusyToken(link.token)
    try {
      await revokeSharedLink(link.token)
      setLinks((current) => current?.filter((item) => item.token !== link.token) ?? null)
      showToast({ key: 'shareManageRevoked' })
    } catch {
      showToast({ key: 'shareManageRevokeFailed', type: 'error' })
    } finally {
      setBusyToken(null)
    }
  }

  return (
    <>
      <div className={clsx(styles.cell, styles.row)}>
        <div className={styles.text}>
          <div className={styles.label}>{t('shareManageLabel')}</div>
          <div className={styles.description}>{t('shareManageDescription')}</div>
        </div>
        <Button
          variant="outlined"
          size="m"
          className={styles.cellButton}
          onClick={() => setOpen(true)}
        >
          {t('shareManageOpen')}
        </Button>
      </div>
      {open ? (
        <Modal
          title={t('shareManageLabel')}
          className={listStyles.dialog}
          onClose={() => setOpen(false)}
        >
          {links === null ? (
            <p className={listStyles.state}>{t('shareManageLoading')}</p>
          ) : failed ? (
            <div className={listStyles.state}>
              <span>{t('shareManageFailed')}</span>
              <Button variant="outlined" size="s" onClick={() => void reload()}>
                {t('retry')}
              </Button>
            </div>
          ) : links.length === 0 ? (
            <p className={listStyles.state}>{t('shareManageEmpty')}</p>
          ) : (
            <ul className={listStyles.list}>
              {links.map((link) => (
                <li key={link.token} className={listStyles.item}>
                  <div className={listStyles.info}>
                    <div className={listStyles.title}>{link.title.trim() || t('untitledChat')}</div>
                    <div className={listStyles.meta}>
                      {t('sharePageSharedAt', {
                        time: formatDate(link.updatedAt) ?? '',
                      })}
                    </div>
                  </div>
                  <div className={listStyles.actions}>
                    <Button size="s" variant="outlined" onClick={() => void copy(link.url)}>
                      {t('shareManageCopy')}
                    </Button>
                    <Button
                      size="s"
                      variant="dangerOutlined"
                      disabled={busyToken === link.token}
                      onClick={() => void revoke(link)}
                    >
                      {t('shareManageRevoke')}
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Modal>
      ) : null}
    </>
  )
}
