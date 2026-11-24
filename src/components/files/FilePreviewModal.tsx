import clsx from 'clsx'
import Prism from 'prismjs'
import { useEffect, useMemo, useReducer, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import {
  formatSize,
  getExtension,
  getFileExt,
  getFileViewType,
  isImage,
} from '../../services/attachments.js'
import { loadFile } from '../../services/chat/db.js'
import {
  getHighlightLang,
  isHighlightLoaded,
  loadHighlight,
} from '../../services/markdown/highlight.js'
import {
  fetchSpreadsheetPreview,
  isSpreadsheetName,
  type SpreadsheetPreviewData,
} from '../../services/spreadsheets.js'
import { copyText } from '../../utils/clipboard.js'
import { Button } from '../base/Button.js'
import {
  IconCheckOutline16,
  IconCopyOutline16,
  IconDownloadOutline16,
  IconRightUpOutline14,
} from '../base/icons.js'
import { Modal } from '../base/Modal.js'
import { showToast } from '../base/toastState.js'
import { Markdown } from '../markdown/Markdown.js'
import { FileIcon } from './FileIcon.js'
import { closeFilePreview, useFilePreview, type PreviewTarget } from './filePreviewState.js'
import {
  parseLocalSpreadsheet,
  sliceLocalSpreadsheetPreview,
  type LocalParsedWorkbook,
} from './localSpreadsheetPreview.js'
import styles from './FilePreviewModal.module.css'

const TEXT_PREVIEW_MAX_BYTES = 300 * 1024
const PAGE_SIZE = 100

const MARKDOWN_EXTS = new Set(['md', 'markdown', 'mkd', 'mkdn', 'mkdown'])
const UNSUPPORTED_BINARY_EXTS = new Set([
  'doc',
  'docx',
  'ppt',
  'pptx',
  'epub',
  'mobi',
  'zip',
  'tar',
  'gz',
  '7z',
  'rar',
  'exe',
  'bin',
  'wasm',
  'mp3',
  'mp4',
  'wav',
  'mov',
  'avi',
])

type PreviewKind = 'spreadsheet' | 'image' | 'pdf' | 'markdown' | 'text' | 'unsupported'

const detectKind = (target: PreviewTarget): PreviewKind => {
  const ext = getFileExt(target.name)
  if (isSpreadsheetName(target.name)) {
    return 'spreadsheet'
  }
  const viewType = getFileViewType(target.name)
  if (isImage(viewType) || (target.mimeType ? isImage(target.mimeType) : false)) {
    return 'image'
  }
  if (ext === 'pdf' || target.mimeType === 'application/pdf') {
    return 'pdf'
  }
  if (MARKDOWN_EXTS.has(ext)) {
    return 'markdown'
  }
  if (UNSUPPORTED_BINARY_EXTS.has(ext)) {
    return 'unsupported'
  }
  return 'text'
}

const decodeTextSample = (buffer: ArrayBuffer): { text: string; isBinary: boolean } => {
  const bytes = new Uint8Array(buffer)
  const checkLen = Math.min(bytes.length, 4096)
  for (let i = 0; i < checkLen; i += 1) {
    if (bytes[i] === 0) {
      return { text: '', isBinary: true }
    }
  }
  let text = new TextDecoder('utf-8', { fatal: false }).decode(bytes)
  if (text.startsWith('\uFEFF')) {
    text = text.slice(1)
  }
  return { text, isBinary: false }
}

/** 全局附件预览弹窗：支持大表格分页/切换工作表/检索、图片缩放、PDF 内嵌、Markdown 渲染与代码高亮 */
export const FilePreviewModal = () => {
  const target = useFilePreview((state) => state.target)
  if (!target) {
    return null
  }
  return <PreviewContent key={`${target.id ?? ''}-${target.spreadsheetId ?? ''}-${target.name}`} target={target} />
}

const PreviewContent = ({ target }: { target: PreviewTarget }) => {
  const t = useTranslate()
  const kind = detectKind(target)
  const ext = getExtension(target.name)

  const [blob, setBlob] = useState<Blob | null | undefined>(() =>
    target.file ? target.file : undefined
  )
  const [blobUrl, setBlobUrl] = useState<string | null>(null)
  const [sheetHeaderInfo, setSheetHeaderInfo] = useState<{
    sheets: number
    rows: number
    structured: boolean
  } | null>(null)
  const [copyableText, setCopyableText] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  // 加载原始 Blob（用于下载、图片/PDF/文本预览，以及无后端索引时的本地表格预览）
  useEffect(() => {
    if (target.file) {
      setBlob(target.file)
      return
    }
    if (!target.id) {
      setBlob(null)
      return
    }
    let active = true
    void loadFile(target.id)
      .then((loaded) => {
        if (active) {
          setBlob(loaded ?? null)
        }
      })
      .catch(() => {
        if (active) {
          setBlob(null)
        }
      })
    return () => {
      active = false
    }
  }, [target.file, target.id])

  // 为下载 / 图片 / PDF 创建临时 ObjectURL
  useEffect(() => {
    if (!blob) {
      setBlobUrl(null)
      return
    }
    const viewType = getFileViewType(target.name) || target.mimeType || blob.type
    const typed =
      viewType && blob.type !== viewType ? blob.slice(0, blob.size, viewType) : blob
    const url = URL.createObjectURL(typed)
    setBlobUrl(url)
    return () => {
      URL.revokeObjectURL(url)
    }
  }, [blob, target.name, target.mimeType])

  const handleCopy = async () => {
    if (copyableText === null) {
      return
    }
    if (!(await copyText(copyableText))) {
      showToast({ key: 'copyFailed' })
      return
    }
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  const canOpenTab = (kind === 'image' || kind === 'pdf') && blobUrl !== null

  const titleNode = (
    <div className={styles.headerTitle}>
      <div className={styles.fileInfo}>
        <span className={styles.fileIcon}>
          <FileIcon ext={ext} />
        </span>
        <div className={styles.fileMeta}>
          <div className={styles.fileName} title={target.name}>
            {target.name}
          </div>
          <div className={styles.fileSub}>
            <span>{[ext, formatSize(target.size)].filter(Boolean).join(' · ')}</span>
            {sheetHeaderInfo ? (
              <span>
                {t('previewSheetStats', {
                  sheets: sheetHeaderInfo.sheets,
                  rows: sheetHeaderInfo.rows.toLocaleString(),
                })}
              </span>
            ) : null}
            {sheetHeaderInfo?.structured ? (
              <span className={styles.badge}>{t('previewStructuredBadge')}</span>
            ) : null}
          </div>
        </div>
      </div>
      <div className={styles.actions}>
        {copyableText !== null ? (
          <button type="button" className={styles.actionBtn} onClick={() => void handleCopy()}>
            {copied ? <IconCheckOutline16 /> : <IconCopyOutline16 />}
            <span>{t(copied ? 'copied' : 'copy')}</span>
          </button>
        ) : null}
        {canOpenTab ? (
          <a
            className={styles.actionBtn}
            href={blobUrl}
            target="_blank"
            rel="noreferrer"
          >
            <IconRightUpOutline14 />
            <span>{t('previewOpenTab')}</span>
          </a>
        ) : null}
        {blobUrl ? (
          <a className={styles.actionBtn} href={blobUrl} download={target.name}>
            <IconDownloadOutline16 />
            <span>{t('previewDownload')}</span>
          </a>
        ) : null}
      </div>
    </div>
  )

  return (
    <Modal
      title={titleNode}
      closable
      className={styles.modal}
      mainClassName={styles.main}
      onClose={closeFilePreview}
    >
      {kind === 'spreadsheet' ? (
        <SpreadsheetPreview
          target={target}
          blob={blob}
          onMeta={setSheetHeaderInfo}
        />
      ) : kind === 'image' ? (
        <ImagePreview name={target.name} blob={blob} blobUrl={blobUrl} />
      ) : kind === 'pdf' ? (
        <PdfPreview name={target.name} blob={blob} blobUrl={blobUrl} />
      ) : kind === 'markdown' || kind === 'text' ? (
        <TextPreview
          name={target.name}
          kind={kind}
          blob={blob}
          blobUrl={blobUrl}
          onTextReady={setCopyableText}
        />
      ) : (
        <UnsupportedPreview name={target.name} blob={blob} blobUrl={blobUrl} />
      )}
    </Modal>
  )
}

/* =========================== 表格预览 =========================== */

const SpreadsheetPreview = ({
  target,
  blob,
  onMeta,
}: {
  target: PreviewTarget
  blob: Blob | null | undefined
  onMeta: (info: { sheets: number; rows: number; structured: boolean } | null) => void
}) => {
  const t = useTranslate()
  const [sheet, setSheet] = useState<string | undefined>(undefined)
  const [searchInput, setSearchInput] = useState('')
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(0)
  const [data, setData] = useState<SpreadsheetPreviewData | null>(null)
  const [localWb, setLocalWb] = useState<LocalParsedWorkbook | null>(null)
  const [useLocalFallback, setUseLocalFallback] = useState(!target.spreadsheetId)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const [selectedCell, setSelectedCell] = useState<{
    rowNum: number
    colLabel: string
    value: string
  } | null>(null)

  // 搜索防抖
  useEffect(() => {
    const timer = setTimeout(() => {
      setSearch(searchInput.trim())
      setPage(0)
    }, 250)
    return () => clearTimeout(timer)
  }, [searchInput])

  // 模式 A：后端分页预览（支持数十万行秒开）
  useEffect(() => {
    if (useLocalFallback || !target.spreadsheetId) {
      return
    }
    const controller = new AbortController()
    setLoading(true)
    setError(false)
    void fetchSpreadsheetPreview(
      target.spreadsheetId,
      { sheet, offset: page * PAGE_SIZE, limit: PAGE_SIZE, search },
      controller.signal
    )
      .then((preview) => {
        if (controller.signal.aborted) {
          return
        }
        setData(preview)
        onMeta({
          sheets: preview.sheets.length,
          rows: preview.totalRows,
          structured: preview.mode === 'structured',
        })
        setLoading(false)
      })
      .catch(() => {
        if (controller.signal.aborted) {
          return
        }
        // 后端不存在（如过期/静态模式）时自动回退到本地原件解析
        if (blob) {
          setUseLocalFallback(true)
        } else {
          setError(true)
          setLoading(false)
        }
      })
    return () => controller.abort()
  }, [useLocalFallback, target.spreadsheetId, sheet, page, search, blob, onMeta])

  // 模式 B：本地原件解析（草稿、静态部署或后端回退）
  useEffect(() => {
    if (!useLocalFallback) {
      return
    }
    if (blob === undefined) {
      setLoading(true)
      return
    }
    if (blob === null) {
      setLoading(false)
      setError(true)
      return
    }
    let active = true
    setLoading(true)
    setError(false)
    void parseLocalSpreadsheet(blob, target.name)
      .then((wb) => {
        if (!active) {
          return
        }
        setLocalWb(wb)
        onMeta({ sheets: wb.sheets.length, rows: wb.totalRows, structured: false })
        setLoading(false)
      })
      .catch(() => {
        if (active) {
          setError(true)
          setLoading(false)
        }
      })
    return () => {
      active = false
    }
  }, [useLocalFallback, blob, target.name, onMeta])

  const previewData = useMemo(() => {
    if (!useLocalFallback) {
      return data
    }
    if (!localWb) {
      return null
    }
    return sliceLocalSpreadsheetPreview(localWb, {
      sheet,
      offset: page * PAGE_SIZE,
      limit: PAGE_SIZE,
      search,
    })
  }, [useLocalFallback, data, localWb, sheet, page, search])

  if (loading && !previewData) {
    return (
      <div className={styles.centerState}>
        <span className={styles.spinner} />
        <span>{t('previewLoading')}</span>
      </div>
    )
  }

  if (error || !previewData) {
    return (
      <div className={styles.centerState}>
        <span>{blob === null && !target.spreadsheetId ? t('previewMissingLocal') : t('previewLoadFailed')}</span>
      </div>
    )
  }

  const totalPages = Math.max(1, Math.ceil(previewData.filteredRows / PAGE_SIZE))
  const currentPage = Math.min(page, totalPages - 1)
  const activeSheetMeta = previewData.sheets.find((s) => s.name === previewData.activeSheet)

  return (
    <div className={styles.sheetContainer}>
      <div className={styles.sheetToolbar}>
        <div className={styles.sheetTabs} role="tablist">
          {previewData.sheets.map((item) => (
            <button
              key={item.tableName}
              type="button"
              role="tab"
              aria-selected={item.name === previewData.activeSheet}
              className={clsx(
                styles.sheetTab,
                item.name === previewData.activeSheet && styles.sheetTabActive
              )}
              onClick={() => {
                setSheet(item.name)
                setPage(0)
                setSelectedCell(null)
              }}
            >
              <span>{item.name}</span>
              <span className={styles.sheetTabCount}>{item.rowCount.toLocaleString()}</span>
            </button>
          ))}
        </div>
        <div className={styles.sheetSearchBox}>
          <input
            type="search"
            className={styles.searchInput}
            placeholder={t('previewSearchPlaceholder')}
            value={searchInput}
            onChange={(event) => setSearchInput(event.target.value)}
          />
        </div>
      </div>

      {selectedCell ? (
        <div className={styles.cellDetailBar}>
          <span className={styles.cellDetailLabel}>
            #{selectedCell.rowNum} · {selectedCell.colLabel}
          </span>
          <div className={styles.cellDetailText}>{selectedCell.value}</div>
        </div>
      ) : null}

      <div className={styles.tableWrap}>
        {previewData.rows.length === 0 ? (
          <div className={styles.centerState}>{t('previewEmptyRows')}</div>
        ) : (
          <table className={styles.dataTable}>
            <thead>
              <tr>
                <th className={styles.rowNumCol}>#</th>
                {previewData.columns.map((col) => (
                  <th key={col.sqlName} title={col.label}>
                    {col.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {previewData.rows.map((row) => (
                <tr key={row.rowNum}>
                  <td className={styles.rowNumCol}>{row.rowNum}</td>
                  {row.values.map((val, colIdx) => {
                    const text = val === null || val === undefined ? '' : String(val)
                    const colLabel = previewData.columns[colIdx]?.label ?? ''
                    const isSelected =
                      selectedCell?.rowNum === row.rowNum && selectedCell?.colLabel === colLabel
                    return (
                      <td
                        key={`${row.rowNum}-${colIdx}`}
                        className={clsx(isSelected && styles.selectedCell)}
                        title={text}
                        onClick={() =>
                          setSelectedCell({ rowNum: row.rowNum, colLabel, value: text })
                        }
                      >
                        {text}
                      </td>
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className={styles.sheetFooter}>
        <span>
          {search
            ? t('previewFilteredRows', {
                filtered: previewData.filteredRows.toLocaleString(),
                total: (activeSheetMeta?.rowCount ?? previewData.totalRows).toLocaleString(),
              })
            : t('previewRowsCount', {
                count: (activeSheetMeta?.rowCount ?? previewData.totalRows).toLocaleString(),
              })}
        </span>
        <div className={styles.pagination}>
          <button
            type="button"
            className={styles.pageBtn}
            disabled={currentPage <= 0 || loading}
            onClick={() => setPage((p) => Math.max(0, p - 1))}
          >
            {t('previewPrevPage')}
          </button>
          <span>
            {t('previewPageInfo', {
              page: currentPage + 1,
              total: totalPages,
            })}
          </span>
          <button
            type="button"
            className={styles.pageBtn}
            disabled={currentPage >= totalPages - 1 || loading}
            onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
          >
            {t('previewNextPage')}
          </button>
        </div>
      </div>
    </div>
  )
}

/* =========================== 图片预览 =========================== */

const ImagePreview = ({
  name,
  blob,
  blobUrl,
}: {
  name: string
  blob: Blob | null | undefined
  blobUrl: string | null
}) => {
  const t = useTranslate()
  const [zoom, setZoom] = useState<number | null>(null)

  if (blob === undefined) {
    return (
      <div className={styles.centerState}>
        <span className={styles.spinner} />
        <span>{t('previewLoading')}</span>
      </div>
    )
  }
  if (!blobUrl) {
    return <div className={styles.centerState}>{t('previewMissingLocal')}</div>
  }

  const stepZoom = (delta: number) => {
    setZoom((prev) => {
      const current = prev ?? 100
      return Math.min(400, Math.max(25, current + delta))
    })
  }

  return (
    <div className={styles.imageStageWrap}>
      <div className={styles.imageToolbar}>
        <button type="button" className={styles.pageBtn} onClick={() => stepZoom(-25)}>
          {t('previewZoomOut')}
        </button>
        <span className={styles.zoomLabel}>{zoom === null ? t('previewZoomReset') : `${zoom}%`}</span>
        <button type="button" className={styles.pageBtn} onClick={() => stepZoom(25)}>
          {t('previewZoomIn')}
        </button>
        <button type="button" className={styles.pageBtn} onClick={() => setZoom(null)}>
          {t('previewZoomReset')}
        </button>
      </div>
      <div
        className={styles.imageViewport}
        onWheel={(event) => {
          if (event.ctrlKey || event.metaKey) {
            event.preventDefault()
            stepZoom(event.deltaY < 0 ? 15 : -15)
          }
        }}
      >
        <img
          src={blobUrl}
          alt={name}
          className={clsx(styles.previewImg, zoom === null && styles.previewImgFit)}
          style={zoom !== null ? { width: `${zoom}%` } : undefined}
        />
      </div>
    </div>
  )
}

/* =========================== PDF 预览 =========================== */

const PdfPreview = ({
  name,
  blob,
  blobUrl,
}: {
  name: string
  blob: Blob | null | undefined
  blobUrl: string | null
}) => {
  const t = useTranslate()
  if (blob === undefined) {
    return (
      <div className={styles.centerState}>
        <span className={styles.spinner} />
        <span>{t('previewLoading')}</span>
      </div>
    )
  }
  if (!blobUrl) {
    return <div className={styles.centerState}>{t('previewMissingLocal')}</div>
  }
  return <iframe className={styles.pdfFrame} src={blobUrl} title={name} />
}

/* =========================== 文本 / 代码 / Markdown 预览 =========================== */

const TextPreview = ({
  name,
  kind,
  blob,
  blobUrl,
  onTextReady,
}: {
  name: string
  kind: 'markdown' | 'text'
  blob: Blob | null | undefined
  blobUrl: string | null
  onTextReady: (text: string | null) => void
}) => {
  const t = useTranslate()
  const ext = getFileExt(name)
  const isJson = ext === 'json' || ext === 'geojson'
  const [state, setState] = useState<{
    loading: boolean
    text: string
    truncated: boolean
    isBinary: boolean
    error: boolean
  }>({ loading: true, text: '', truncated: false, isBinary: false, error: false })
  const [renderMd, setRenderMd] = useState(kind === 'markdown')
  const [prettyJson, setPrettyJson] = useState(true)

  const rerender = useReducer((n: number) => n + 1, 0)[1]
  const lang = getHighlightLang(ext)
  const loaded = lang !== null && isHighlightLoaded(lang)

  useEffect(() => {
    if (lang === null || loaded) {
      return
    }
    let unmounted = false
    void loadHighlight(lang).then(() => {
      if (!unmounted) {
        rerender()
      }
    })
    return () => {
      unmounted = true
    }
  }, [lang, loaded, rerender])

  useEffect(() => {
    if (blob === undefined) {
      return
    }
    if (blob === null) {
      setState({ loading: false, text: '', truncated: false, isBinary: false, error: true })
      onTextReady(null)
      return
    }
    let active = true
    const truncated = blob.size > TEXT_PREVIEW_MAX_BYTES
    const slice = truncated ? blob.slice(0, TEXT_PREVIEW_MAX_BYTES) : blob
    void slice
      .arrayBuffer()
      .then((buf) => {
        if (!active) {
          return
        }
        const decoded = decodeTextSample(buf)
        setState({
          loading: false,
          text: decoded.text,
          truncated,
          isBinary: decoded.isBinary,
          error: false,
        })
        onTextReady(decoded.isBinary ? null : decoded.text)
      })
      .catch(() => {
        if (active) {
          setState({ loading: false, text: '', truncated: false, isBinary: false, error: true })
          onTextReady(null)
        }
      })
    return () => {
      active = false
    }
  }, [blob, onTextReady])

  const displayText = useMemo(() => {
    if (!isJson || !prettyJson || state.truncated || !state.text) {
      return state.text
    }
    try {
      return JSON.stringify(JSON.parse(state.text), null, 2)
    } catch {
      return state.text
    }
  }, [isJson, prettyJson, state.truncated, state.text])

  const highlightedHtml = useMemo(() => {
    if (renderMd && kind === 'markdown') {
      return null
    }
    const prismLang = lang !== null && loaded ? lang : 'plaintext'
    return Prism.highlight(displayText, Prism.languages[prismLang], prismLang)
  }, [displayText, kind, lang, loaded, renderMd])

  if (state.loading) {
    return (
      <div className={styles.centerState}>
        <span className={styles.spinner} />
        <span>{t('previewLoading')}</span>
      </div>
    )
  }

  if (state.error) {
    return (
      <div className={styles.centerState}>
        {blob === null ? t('previewMissingLocal') : t('previewLoadFailed')}
      </div>
    )
  }

  if (state.isBinary) {
    return <UnsupportedPreview name={name} blob={blob} blobUrl={blobUrl} />
  }

  return (
    <div className={styles.textContainer}>
      {kind === 'markdown' || (isJson && !state.truncated) ? (
        <div className={styles.textToolbar}>
          <div className={styles.segmentGroup}>
            {kind === 'markdown' ? (
              <>
                <button
                  type="button"
                  className={clsx(styles.segmentBtn, renderMd && styles.segmentBtnActive)}
                  onClick={() => setRenderMd(true)}
                >
                  {t('previewRendered')}
                </button>
                <button
                  type="button"
                  className={clsx(styles.segmentBtn, !renderMd && styles.segmentBtnActive)}
                  onClick={() => setRenderMd(false)}
                >
                  {t('previewSource')}
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  className={clsx(styles.segmentBtn, prettyJson && styles.segmentBtnActive)}
                  onClick={() => setPrettyJson(true)}
                >
                  {t('previewFormatJson')}
                </button>
                <button
                  type="button"
                  className={clsx(styles.segmentBtn, !prettyJson && styles.segmentBtnActive)}
                  onClick={() => setPrettyJson(false)}
                >
                  {t('previewRawJson')}
                </button>
              </>
            )}
          </div>
        </div>
      ) : null}

      {state.truncated ? (
        <div className={styles.truncateBanner}>
          {t('previewTruncatedNotice', { size: formatSize(TEXT_PREVIEW_MAX_BYTES) })}
        </div>
      ) : null}

      {kind === 'markdown' && renderMd ? (
        <div className={styles.markdownScroll}>
          <Markdown
            content={displayText}
            loading={false}
            cacheKey={`preview-${name}`}
            disableLink={false}
          />
        </div>
      ) : (
        <pre
          className={styles.codeScroll}
          dangerouslySetInnerHTML={{ __html: highlightedHtml ?? '' }}
        />
      )}
    </div>
  )
}

/* =========================== 不支持在线预览的兜底 =========================== */

const UnsupportedPreview = ({
  name,
  blob,
  blobUrl,
}: {
  name: string
  blob: Blob | null | undefined
  blobUrl: string | null
}) => {
  const t = useTranslate()
  const ext = getExtension(name)
  return (
    <div className={styles.centerState}>
      <FileIcon ext={ext} />
      <span>{blob === null ? t('previewMissingLocal') : t('previewUnavailable')}</span>
      {blobUrl ? (
        <a href={blobUrl} download={name} style={{ textDecoration: 'none' }}>
          <Button variant="primary" size="m">
            {t('previewDownload')}
          </Button>
        </a>
      ) : null}
    </div>
  )
}
