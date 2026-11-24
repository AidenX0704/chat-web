import { useEffect, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { searchSessions, type SessionSearchHit } from '../../services/chat/search.js'
import { selectSession } from '../../services/chat/store.js'
import { IconSearchOutline16 } from '../base/icons.js'
import { Modal } from '../base/Modal.js'
import { closeMobileSider } from './mobileSiderState.js'
import styles from './SessionSearch.module.css'

/** 输入停顿多久后开始搜索 */
const SEARCH_DELAY = 200

/**
 * 全局对话搜索：跨全部会话检索标题与消息正文。
 * 输入时打断上一次搜索（AbortSignal），扫完一个会话就先用已有结果刷新列表。
 */
export const SessionSearch = ({ onClose }: { onClose: () => void }) => {
  const t = useTranslate()
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<SessionSearchHit[]>([])
  const [searching, setSearching] = useState(false)

  useEffect(() => {
    const keyword = query.trim()
    if (keyword === '') {
      setHits([])
      setSearching(false)
      return
    }
    const controller = new AbortController()
    setSearching(true)
    const timer = setTimeout(() => {
      void searchSessions(keyword, {
        signal: controller.signal,
        onProgress: (next) => {
          if (!controller.signal.aborted) {
            setHits(next)
          }
        },
      })
        .then((next) => {
          if (controller.signal.aborted) {
            return
          }
          setHits(next)
          setSearching(false)
        })
        .catch(() => {
          if (!controller.signal.aborted) {
            setSearching(false)
          }
        })
    }, SEARCH_DELAY)
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [query])

  const open = (hit: SessionSearchHit) => {
    selectSession(hit.sessionId)
    closeMobileSider()
    onClose()
  }

  return (
    <Modal
      title={t('searchConversationsButton')}
      closable
      onClose={onClose}
      className={styles.dialog}
      mainClassName={styles.main}
    >
      <div className={styles.field}>
        <span className={styles.fieldIcon}>
          <IconSearchOutline16 />
        </span>
        <input
          className={styles.input}
          value={query}
          autoFocus
          placeholder={t('searchConversationsPlaceholder')}
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>
      <div className={styles.results}>
        {hits.length === 0 ? (
          <div className={styles.hint}>
            {query.trim() === ''
              ? t('searchConversationsHint')
              : searching
                ? t('searchConversationsSearching')
                : t('searchConversationsEmpty')}
          </div>
        ) : (
          hits.map((hit) => (
            <button
              key={hit.sessionId + ':' + (hit.messageId ?? 'title')}
              type="button"
              className={styles.hit}
              onClick={() => open(hit)}
            >
              <span className={styles.hitTitle}>{hit.title || t('untitledChat')}</span>
              <span className={styles.hitSnippet}>
                <span className={styles.hitRole}>
                  {hit.role === undefined
                    ? t('searchConversationTitleMatch')
                    : hit.role === 'user'
                      ? t('sessionShareUserRole')
                      : t('sessionShareAssistantRole')}
                </span>
                {hit.before}
                <mark className={styles.mark}>{hit.match}</mark>
                {hit.after}
              </span>
            </button>
          ))
        )}
        {hits.length > 0 && searching ? (
          <div className={styles.progress}>{t('searchConversationsSearching')}</div>
        ) : null}
      </div>
    </Modal>
  )
}
