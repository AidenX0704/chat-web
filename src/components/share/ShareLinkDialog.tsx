import clsx from 'clsx'
import { useEffect, useRef, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { shareSession } from '../../services/chat/share.js'
import type { Session } from '../../services/chat/types.js'
import { copyText } from '../../utils/clipboard.js'
import { Button } from '../base/Button.js'
import { IconCheckOutline16, IconCopyOutline16 } from '../base/icons.js'
import { Modal } from '../base/Modal.js'
import { showToast } from '../base/toastState.js'
import styles from './ShareLinkDialog.module.css'

type CopyStatus = 'autoCopied' | 'copied' | 'failed'

/**
 * 创建分享链接弹窗：
 * 1. 创建前二次确认：说清「拿到链接的人都能看」，提醒先检查敏感内容，并说明可在设置里撤销；
 * 2. 创建成功后默认自动复制到剪贴板，并在弹窗里展示生成的链接与复制按钮。
 */
export const ShareLinkDialog = ({
  session,
  messageIds,
  onClose,
}: {
  session: Session
  /** 只分享选中的消息；null 表示整段会话 */
  messageIds: string[] | null
  /** 弹窗关闭后调用；created 表示链接已生成，可以结束整个分享流程 */
  onClose: (created: boolean) => void
}) => {
  const t = useTranslate()
  const [busy, setBusy] = useState(false)
  const [createdUrl, setCreatedUrl] = useState<string | null>(null)
  const [copyStatus, setCopyStatus] = useState<CopyStatus>('autoCopied')
  const [justCopied, setJustCopied] = useState(false)
  const running = useRef(false)
  const copyTimer = useRef<ReturnType<typeof setTimeout>>(undefined)

  useEffect(() => () => clearTimeout(copyTimer.current), [])

  const markCopied = () => {
    clearTimeout(copyTimer.current)
    setJustCopied(true)
    copyTimer.current = setTimeout(() => setJustCopied(false), 2000)
  }

  const create = async () => {
    if (running.current) {
      return
    }
    running.current = true
    setBusy(true)
    try {
      const result = await shareSession(
        session.id,
        {
          untitled: t('untitledChat'),
          user: t('sessionShareUserRole'),
          assistant: t('sessionShareAssistantRole'),
        },
        messageIds
      )
      if (result.kind === 'markdown') {
        showToast({ key: 'sessionShareCopied' })
        onClose(true)
        return
      }
      if (result.kind === 'failed') {
        // 失败时只关掉确认弹窗、保留勾选，用户可以再点一次
        showToast({ key: 'sessionShareLinkFailed', type: 'error' })
        onClose(false)
        return
      }
      setCreatedUrl(result.url)
      if (result.copied) {
        setCopyStatus('autoCopied')
        markCopied()
      } else {
        setCopyStatus('failed')
        setJustCopied(false)
      }
    } finally {
      running.current = false
      setBusy(false)
    }
  }

  const copyLink = async () => {
    if (!createdUrl) {
      return
    }
    if (await copyText(createdUrl)) {
      setCopyStatus('copied')
      markCopied()
      showToast({ key: 'shareManageCopied' })
    } else {
      setCopyStatus('failed')
      setJustCopied(false)
      showToast({ key: 'copyFailed', type: 'error' })
    }
  }

  if (createdUrl !== null) {
    const descriptionKey =
      copyStatus === 'autoCopied'
        ? 'shareCreatedDescription'
        : copyStatus === 'copied'
          ? 'shareCreatedCopiedDescription'
          : 'shareCreatedCopyFailed'

    return (
      <Modal
        title={t('shareCreatedTitle')}
        closable
        className={styles.createdDialog}
        onClose={() => onClose(true)}
      >
        <p className={clsx(styles.description, copyStatus === 'failed' && styles.copyError)}>
          {t(descriptionKey)}
        </p>
        <div className={styles.linkRow}>
          <input
            type="text"
            readOnly
            value={createdUrl}
            aria-label={t('shareCreatedLinkLabel')}
            className={styles.linkInput}
            onFocus={(event) => event.currentTarget.select()}
            onClick={(event) => event.currentTarget.select()}
          />
          <Button size="m" autoFocus className={styles.copyButton} onClick={() => void copyLink()}>
            {justCopied ? <IconCheckOutline16 /> : <IconCopyOutline16 />}
            {t(justCopied ? 'copied' : 'shareManageCopy')}
          </Button>
        </div>
      </Modal>
    )
  }

  return (
    <Modal
      title={t('shareConfirmTitle')}
      onClose={() => {
        if (!busy) {
          onClose(false)
        }
      }}
      footer={
        <>
          <Button variant="outlined" autoFocus disabled={busy} onClick={() => onClose(false)}>
            {t('cancel')}
          </Button>
          <Button disabled={busy} onClick={() => void create()}>
            {t(busy ? 'shareConfirmBusy' : 'shareConfirmAction')}
          </Button>
        </>
      }
    >
      <p className={styles.description}>{t('shareConfirmDescription')}</p>
    </Modal>
  )
}
