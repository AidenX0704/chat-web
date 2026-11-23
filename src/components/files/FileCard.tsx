import clsx from 'clsx'
import type { AnchorHTMLAttributes, ReactNode } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { formatSize, getExtension } from '../../services/attachments.js'
import { IconCloseFill14, IconRefreshOutline16 } from '../base/icons.js'
import { FileIcon } from './FileIcon.js'
import styles from './FileCard.module.css'

/**
 * 文档文件卡片：图标 + 文件名 + 「扩展名 大小」或状态文案。
 * 输入框内失败时描边和说明标红；可重试时显示刷新图标，不可重试时常显红色删除按钮。
 * 消息里的不可重试文件保留普通边框和状态说明。
 */
export const FileCard = ({
  name,
  size,
  subtitle,
  status = 'done',
  error,
  onRetry,
  onRemove,
  onPreview,
  link,
}: {
  name: string
  size: number
  /** 附加信息（如表格行数），替换默认「扩展名 大小」 */
  subtitle?: string
  status?: 'uploading' | 'done' | 'error'
  error?: string
  onRetry?: () => void
  onRemove?: () => void
  /** 点击卡片打开应用内预览（提供后优先于直接下载链接） */
  onPreview?: () => void
  link?: AnchorHTMLAttributes<HTMLAnchorElement>
}) => {
  const t = useTranslate()
  const ext = getExtension(name)
  let icon: ReactNode = <FileIcon ext={ext} />
  let description = subtitle ?? [ext, formatSize(size)].filter(Boolean).join(' ')
  if (status === 'uploading') {
    icon = <span className={styles.spinner} />
    description = t('uploadFileStatusUploading')
  } else if (status === 'error') {
    // 不可重试（过大、格式不支持）时保留文件图标并显示原因
    if (onRetry) {
      icon = <IconRefreshOutline16 />
    }
    description = error ?? t('uploadFileStatusFailed')
  }
  const onClick = status === 'error' ? onRetry : onPreview
  const fileLink = status === 'done' && !onPreview ? link : undefined
  return (
    <div
      className={clsx(
        styles.card,
        onRemove && styles.editable,
        status === 'error' && (onRemove || onRetry) && styles.failed,
        (onClick || fileLink) && styles.clickable
      )}
      title={
        status === 'error'
          ? onRetry
            ? t('uploadRetry', { message: description })
            : description
          : onPreview
            ? `${name} (${t('previewClickHint')})`
            : name
      }
      onClick={onClick}
    >
      <div className={clsx(styles.icon, status === 'error' && onRetry && styles.retry)}>{icon}</div>
      <div className={styles.content}>
        <div className={styles.caption}>{name}</div>
        <div className={styles.subCaption}>{description}</div>
      </div>
      {fileLink && <a {...fileLink} aria-label={name} />}
      {onRemove ? (
        <button
          type="button"
          className={clsx(styles.remove, status === 'error' && !onRetry && styles.invalidRemove)}
          aria-label={t('delete')}
          onClick={(event) => {
            event.stopPropagation()
            onRemove()
          }}
        >
          <IconCloseFill14 />
        </button>
      ) : null}
    </div>
  )
}
