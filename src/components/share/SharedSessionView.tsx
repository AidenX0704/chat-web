import { useEffect, useMemo, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { getVisibleMessages } from '../../services/chat/branches.js'
import {
  fetchSharedSession,
  ShareLinkError,
  type ShareFailure,
  type SharedSession,
} from '../../services/chat/share.js'
import type { AssistantMessage, Message } from '../../services/chat/types.js'
import { buildReplyView } from '../../services/chat/view.js'
import { useSettings } from '../../services/settings.js'
import { formatDate } from '../../utils/format.js'
import { BrandMark } from '../base/BrandMark.js'
import { Button } from '../base/Button.js'
import { IconWarningOutline16 } from '../base/icons.js'
import { Markdown } from '../markdown/Markdown.js'
import styles from './SharedSessionView.module.css'

type ViewState =
  | { status: 'loading' }
  | { status: 'ready'; shared: SharedSession }
  | { status: 'failed'; reason: ShareFailure }

/** 分享链接里的时间只到分钟，够定位，也不会让页面显得啰嗦 */
const shareTime = (value: number): string => {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return ''
  }
  const day = formatDate(date) ?? ''
  const minutes = String(date.getMinutes()).padStart(2, '0')
  return `${day} ${date.getHours()}:${minutes}`
}

/** 助手回答：只取正文（含引用角标），思考与工具步骤不进入分享 */
const SharedReply = ({ message }: { message: AssistantMessage }) => {
  const t = useTranslate()
  const view = useMemo(() => buildReplyView(message, false), [message])
  if (!view.answer) {
    return <p className={styles.empty}>{t('sharePageEmptyAnswer')}</p>
  }
  return (
    <Markdown
      className={styles.markdown}
      content={view.answer.markdown}
      loading={false}
      cacheKey={message.id}
      disableLink={false}
      sources={view.sources}
    />
  )
}

const SharedMessage = ({ message }: { message: Message }) => {
  // 分享页没有登录态：用户消息保留换行，附件只列文件名
  return message.role === 'user' ? (
    <div className={styles.userRow}>
      <div className={styles.bubble}>
        {message.content ? <p className={styles.userText}>{message.content}</p> : null}
        {message.files.length > 0 ? (
          <ul className={styles.files}>
            {message.files.map((file) => (
              <li key={file.id} className={styles.file}>
                {file.name}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </div>
  ) : (
    <div className={styles.assistantRow}>
      <SharedReply message={message} />
    </div>
  )
}

/**
 * 分享页：只读展示一份会话快照，不需要登录。
 * 顶部说明「来自分享的对话」并提示内容由 AI 生成，读完后可以回主站继续聊。
 */
export const SharedSessionView = ({ token }: { token: string }) => {
  const t = useTranslate()
  const locale = useSettings((state) => state.locale)
  const [state, setState] = useState<ViewState>({ status: 'loading' })
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    document.documentElement.lang = locale
  }, [locale])

  useEffect(() => {
    let cancelled = false
    setState({ status: 'loading' })
    void fetchSharedSession(token)
      .then((shared) => {
        if (!cancelled) {
          setState({ status: 'ready', shared })
        }
      })
      .catch((error: unknown) => {
        if (cancelled) {
          return
        }
        setState({
          status: 'failed',
          reason: error instanceof ShareLinkError ? error.reason : 'server',
        })
      })
    return () => {
      cancelled = true
    }
  }, [attempt, token])

  // 标题跟着分享内容走：浏览器标签页和分享预览里都能直接看到会话名
  useEffect(() => {
    if (state.status !== 'ready') {
      return
    }
    const title = state.shared.session.title.trim()
    document.title = title === '' ? t('appName') : `${title} · ${t('appName')}`
  }, [state, t])

  const messages = state.status === 'ready' ? getVisibleMessages(state.shared.session) : []
  const title =
    state.status === 'ready'
      ? state.shared.session.title.trim() || state.shared.title.trim() || t('untitledChat')
      : ''

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <div className={styles.headerInner}>
          <a className={styles.brand} href="/" aria-label={t('appName')}>
            <BrandMark size="sider" />
          </a>
          <span className={styles.divider} aria-hidden="true" />
          <span className={styles.headerLabel}>{t('sharePageFromLink')}</span>
        </div>
      </header>

      <main className={styles.main}>
        {state.status === 'loading' ? (
          <div className={styles.state} role="status" aria-live="polite">
            <span className={styles.spinner} aria-hidden="true" />
            <span>{t('sharePageLoading')}</span>
          </div>
        ) : state.status === 'failed' ? (
          <div className={styles.state} role="alert">
            <p className={styles.stateText}>
              {state.reason === 'invalid'
                ? t('sharePageInvalid')
                : state.reason === 'network'
                  ? t('sharePageNetworkFailed')
                  : t('sharePageServerFailed')}
            </p>
            {state.reason === 'invalid' ? null : (
              <Button variant="outlined" size="m" onClick={() => setAttempt((value) => value + 1)}>
                {t('retry')}
              </Button>
            )}
          </div>
        ) : (
          <>
            <div className={styles.notice} role="note">
              <IconWarningOutline16 />
              <span>{t('sharePageNotice')}</span>
            </div>
            <article className={styles.article} aria-labelledby="share-title">
              <h1 id="share-title" className={styles.title}>
                {title}
              </h1>
              <p className={styles.note}>
                {t('sharePageSharedAt', { time: shareTime(state.shared.createdAt) })}
              </p>
              <div className={styles.messages}>
                {messages.map((message) => (
                  <SharedMessage key={message.id} message={message} />
                ))}
              </div>
              <div className={styles.cta}>
                {/* 回主站开一段自己的新对话：分享页只读，不会影响原对话 */}
                <a className={styles.ctaButton} href="/">
                  {t('sharePageContinue', { app: t('appName') })}
                </a>
              </div>
            </article>
          </>
        )}
      </main>

    </div>
  )
}
