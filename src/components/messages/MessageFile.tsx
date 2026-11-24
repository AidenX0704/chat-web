import clsx from 'clsx'
import { useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { formatSize, getExtension, useUploads } from '../../services/attachments.js'
import type { FileAttachment } from '../../services/chat/types.js'
import { IconPhotoErrorFill20, IconRefreshOutline16 } from '../base/icons.js'
import { Tooltip } from '../base/Tooltip.js'
import { FileCard } from '../files/FileCard.js'
import { openFilePreview } from '../files/filePreviewState.js'
import { useFileView } from '../files/useFileView.js'
import styles from './MessageFile.module.css'

/** 历史或失效附件的补传状态：只在还没有 serverId 且未入库为结构化表格时显示 */
const useUploadState = (file: FileAttachment) =>
  useUploads((state) => {
    if (file.serverId || file.spreadsheet) {
      return null
    }
    const task = state.tasks[file.id]
    return task?.status === 'uploading' || task?.status === 'error' ? task : null
  })

/**
 * 消息里的附件：
 * - 图片：纯图片显示 120×120 缩略图，与文件混排时为 64×64；上传中显示 loading 蒙层，
 *   上传失败显示品牌色描边 + 中心重试图标（可重试）或 photo-error 图标（不可重试）。
 * - 文件：显示文件卡片。
 */
export const MessageFile = ({
  file,
  onRetry,
}: {
  file: FileAttachment
  /** 本条消息补传失败且可重试时提供 */
  onRetry: (() => void) | null
}) => {
  const t = useTranslate()
  // 结构化大表格卡片无需在列表渲染时整份下载原件，点击预览时走后端分页并按需加载下载链接
  const { image, url, link } = useFileView(file.id, file.name, Boolean(file.spreadsheet))
  const [failedUrl, setFailedUrl] = useState<string | null>(null)
  const upload = useUploadState(file)
  const uploading = upload?.status === 'uploading'
  const failed = upload?.status === 'error'
  const retryable = failed && upload.retryable
  const errorText = failed ? t(upload.error.key, upload.error.params) : undefined

  const retry = retryable ? onRetry : null

  if (image && url !== null) {
    const preview = url ? (
      failedUrl === url ? (
        <span className={styles.failedIcon} role="img" aria-label={file.name}>
          <IconPhotoErrorFill20 />
        </span>
      ) : (
        <img src={url} alt={file.name} onError={() => setFailedUrl(url)} />
      )
    ) : null

    // 上传中：本地原件已在 IndexedDB，先垫在蒙层下显示，避免只有一块灰色占位
    if (uploading) {
      return (
        <div className={clsx(styles.image, styles.imageThumb)} title={file.name}>
          {preview}
          <div className={styles.overlay}>
            <span className={styles.spinner} />
          </div>
        </div>
      )
    }

    // 「上传失败」只显示状态，其余原因写在图片底部的渐变上
    const reason =
      errorText && errorText !== t('uploadFileStatusFailed') ? (
        <span className={styles.reason}>{errorText}</span>
      ) : null

    // 上传失败不可重试：保留缩略图，底部渐变显示原因
    if (failed && !retry) {
      return (
        <div
          className={clsx(styles.image, styles.imageThumb)}
          title={errorText}
          aria-label={errorText}
        >
          {preview ?? (
            <span className={styles.failedIcon}>
              <IconPhotoErrorFill20 />
            </span>
          )}
          {reason}
        </div>
      )
    }

    // 上传失败可重试：缩略图 + 红色描边 + 蒙层重试图标，原因在底部
    if (failed && retry) {
      const retryLabel = t('uploadRetry', { message: errorText ?? t('uploadFileStatusFailed') })
      return (
        <Tooltip content={retryLabel}>
          <button
            type="button"
            className={clsx(styles.image, styles.imageThumb, styles.retryImage)}
            aria-label={retryLabel}
            onClick={retry}
          >
            {preview}
            <div className={clsx(styles.overlay, styles.retryOverlay)}>
              <IconRefreshOutline16 />
            </div>
            {reason}
          </button>
        </Tooltip>
      )
    }

    // 正常态：点击打开应用内图片预览
    return link ? (
      <a
        className={clsx(styles.image, styles.imageThumb)}
        href={link.href}
        title={`${file.name} (${t('previewClickHint')})`}
        onClick={(event) => {
          event.preventDefault()
          openFilePreview({
            id: file.id,
            name: file.name,
            size: file.size,
            mimeType: file.mimeType,
          })
        }}
      >
        {preview}
      </a>
    ) : (
      // 原件还没加载出来（极短暂）
      <div className={styles.image} />
    )
  }

  const canPreview = Boolean(link || file.spreadsheet)
  const subtitle = file.spreadsheet
    ? `${[getExtension(file.name), formatSize(file.size)].filter(Boolean).join(' ')} · ${t('previewRowsCount', { count: file.spreadsheet.totalRows.toLocaleString() })}`
    : undefined

  return (
    <FileCard
      name={file.name}
      size={file.size}
      subtitle={subtitle}
      status={uploading ? 'uploading' : failed ? 'error' : 'done'}
      error={errorText}
      onPreview={
        canPreview && !failed
          ? () =>
              openFilePreview({
                id: file.id,
                name: file.name,
                size: file.size,
                mimeType: file.mimeType,
                spreadsheetId: file.spreadsheet?.id,
              })
          : undefined
      }
      onRetry={retry ?? undefined}
      link={link}
    />
  )
}
