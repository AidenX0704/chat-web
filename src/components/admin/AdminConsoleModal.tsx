import clsx from 'clsx'
import { useCallback, useEffect, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import {
  clearAdminLogs,
  deleteAdminLog,
  fetchAdminLogs,
  fetchAdminOverview,
  fetchAdminVisitors,
  resetAdminVisitorQuota,
  updateAdminPolicy,
  updateAdminVisitorRule,
  type AdminGuestLog,
  type AdminGuestPolicy,
  type AdminOverview,
  type AdminVisitor,
} from '../../services/admin.js'
import { Button } from '../base/Button.js'
import { Modal } from '../base/Modal.js'
import { showToast } from '../base/toastState.js'
import { Markdown } from '../markdown/Markdown.js'
import {
  closeAdminConsole,
  useAdminConsole,
  type AdminTab,
} from './adminConsoleState.js'
import styles from './AdminConsoleModal.module.css'

const DAILY_PRESETS = [5, 10, 20, 50, 100]
const LOGS_PAGE_SIZE = 30

const formatDateTime = (ts: number): string => {
  if (!ts) {
    return '—'
  }
  const d = new Date(ts)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

const formatCompactNumber = (n: number): string => {
  if (n >= 1_000_000) {
    return `${(n / 1_000_000).toFixed(1)}M`
  }
  if (n >= 1_000) {
    return `${(n / 1_000).toFixed(1)}K`
  }
  return String(n)
}

/** 唯一管理员后台管理平台：访客免费对话策略、IP 额度与封禁管理、免登录会话内容完整审计 */
export const AdminConsoleModal = () => {
  const open = useAdminConsole((state) => state.open)
  return open ? <AdminConsoleContent /> : null
}

const AdminConsoleContent = () => {
  const t = useTranslate()
  const initialTab = useAdminConsole((state) => state.tab)
  const initialFilterIp = useAdminConsole((state) => state.filterIp)
  const [tab, setTab] = useState<AdminTab>(initialTab)
  const [logFilterIp, setLogFilterIp] = useState(initialFilterIp)

  useEffect(() => {
    setTab(initialTab)
    setLogFilterIp(initialFilterIp)
  }, [initialTab, initialFilterIp])

  const openLogsForIp = useCallback((ip: string) => {
    setLogFilterIp(ip)
    setTab('logs')
  }, [])

  const titleNode = (
    <div className={styles.headerRow}>
      <span>{t('adminConsole')}</span>
      <div className={styles.tabs} role="tablist">
        {(
          [
            ['policy', 'adminTabPolicy'],
            ['visitors', 'adminTabVisitors'],
            ['logs', 'adminTabLogs'],
          ] as const
        ).map(([key, labelKey]) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={tab === key}
            className={clsx(styles.tabBtn, tab === key && styles.tabBtnActive)}
            onClick={() => setTab(key)}
          >
            {t(labelKey)}
          </button>
        ))}
      </div>
    </div>
  )

  return (
    <Modal
      title={titleNode}
      closable
      className={styles.modal}
      mainClassName={styles.main}
      onClose={closeAdminConsole}
    >
      {tab === 'policy' ? (
        <PolicyPanel />
      ) : tab === 'visitors' ? (
        <VisitorsPanel onViewLogs={openLogsForIp} />
      ) : (
        <LogsPanel filterIp={logFilterIp} onChangeFilterIp={setLogFilterIp} />
      )}
    </Modal>
  )
}

/* =========================== Tab 1: 策略配置与概览 =========================== */

const PolicyPanel = () => {
  const t = useTranslate()
  const [overview, setOverview] = useState<AdminOverview | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [limitInput, setLimitInput] = useState('10')

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const data = await fetchAdminOverview()
      setOverview(data)
      setLimitInput(String(data.policy.dailyMessages))
    } catch {
      showToast({ key: 'adminLoadFailed', type: 'error' })
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const patchPolicy = async (patch: Partial<Omit<AdminGuestPolicy, 'updatedAt'>>) => {
    setSaving(true)
    try {
      const { policy } = await updateAdminPolicy(patch)
      setOverview((prev) => (prev ? { ...prev, policy } : prev))
      setLimitInput(String(policy.dailyMessages))
      showToast({ key: 'adminSaveSuccess' })
    } catch {
      showToast({ key: 'adminSaveFailed', type: 'error' })
    } finally {
      setSaving(false)
    }
  }

  if (loading && !overview) {
    return <div className={styles.emptyState}>{t('adminLoading')}</div>
  }
  if (!overview) {
    return (
      <div className={styles.emptyState}>
        <Button variant="outlined" onClick={() => void load()}>
          {t('retry')}
        </Button>
      </div>
    )
  }

  const { policy, stats } = overview
  const parsedLimit = Number(limitInput)
  const limitValid = Number.isInteger(parsedLimit) && parsedLimit >= 0 && parsedLimit <= 10000

  return (
    <div className={styles.scrollArea}>
      <div className={styles.statsGrid}>
        <div className={styles.statCard}>
          <div className={styles.statLabel}>{t('adminStatTodayMessages')}</div>
          <div className={styles.statValue}>{stats.todayMessages.toLocaleString()}</div>
          <div className={styles.statSub}>
            {t('adminStatTodayIps')}: {stats.todayIps.toLocaleString()}
          </div>
        </div>
        <div className={styles.statCard}>
          <div className={styles.statLabel}>{t('adminStatTotalMessages')}</div>
          <div className={styles.statValue}>{stats.totalMessages.toLocaleString()}</div>
          <div className={styles.statSub}>
            {t('adminStatTotalIps')}: {stats.totalIps.toLocaleString()}
          </div>
        </div>
        <div className={styles.statCard}>
          <div className={styles.statLabel}>{t('adminStatTodayIps')}</div>
          <div className={styles.statValue}>{stats.todayIps.toLocaleString()}</div>
          <div className={styles.statSub}>
            {t('adminPolicyDailyLimit')}: {policy.enabled ? policy.dailyMessages : 0}
          </div>
        </div>
        <div className={styles.statCard}>
          <div className={styles.statLabel}>{t('adminStatTokens')}</div>
          <div className={styles.statValue}>
            {formatCompactNumber(stats.totalInputTokens)} /{' '}
            {formatCompactNumber(stats.totalOutputTokens)}
          </div>
          <div className={styles.statSub}>
            {stats.totalSessions.toLocaleString()} sessions
          </div>
        </div>
      </div>

      <div className={styles.policyList}>
        <PolicySwitchRow
          title={t('adminPolicyGuestEnabled')}
          description={t('adminPolicyGuestEnabledDesc')}
          checked={policy.enabled}
          disabled={saving}
          onToggle={() => void patchPolicy({ enabled: !policy.enabled })}
        />

        <div className={styles.policyRow}>
          <div className={styles.policyText}>
            <div className={styles.policyTitle}>{t('adminPolicyDailyLimit')}</div>
            <div className={styles.policyDesc}>{t('adminPolicyDailyLimitDesc')}</div>
          </div>
          <div className={styles.limitControl}>
            <div className={styles.presetRow}>
              {DAILY_PRESETS.map((n) => (
                <button
                  key={n}
                  type="button"
                  disabled={saving}
                  className={clsx(
                    styles.presetBtn,
                    policy.dailyMessages === n && styles.presetBtnActive
                  )}
                  onClick={() => void patchPolicy({ dailyMessages: n })}
                >
                  {n}
                </button>
              ))}
            </div>
            <input
              type="number"
              min={0}
              max={10000}
              className={styles.numberInput}
              value={limitInput}
              onChange={(event) => setLimitInput(event.target.value)}
            />
            <Button
              size="s"
              variant="primary"
              disabled={saving || !limitValid || parsedLimit === policy.dailyMessages}
              onClick={() => void patchPolicy({ dailyMessages: parsedLimit })}
            >
              {t('adminSaveLimit')}
            </Button>
          </div>
        </div>

        <PolicySwitchRow
          title={t('adminPolicyAllowAttachments')}
          description={t('adminPolicyAllowAttachmentsDesc')}
          checked={policy.allowAttachments}
          disabled={saving}
          onToggle={() => void patchPolicy({ allowAttachments: !policy.allowAttachments })}
        />

        <PolicySwitchRow
          title={t('adminPolicyAllowSearch')}
          description={t('adminPolicyAllowSearchDesc')}
          checked={policy.allowSearch}
          disabled={saving}
          onToggle={() => void patchPolicy({ allowSearch: !policy.allowSearch })}
        />

        <PolicySwitchRow
          title={t('adminPolicyAllowThinking')}
          description={t('adminPolicyAllowThinkingDesc')}
          checked={policy.allowThinking}
          disabled={saving}
          onToggle={() => void patchPolicy({ allowThinking: !policy.allowThinking })}
        />
      </div>
    </div>
  )
}

const PolicySwitchRow = ({
  title,
  description,
  checked,
  disabled,
  onToggle,
}: {
  title: string
  description: string
  checked: boolean
  disabled: boolean
  onToggle: () => void
}) => (
  <div className={styles.policyRow}>
    <div className={styles.policyText}>
      <div className={styles.policyTitle}>{title}</div>
      <div className={styles.policyDesc}>{description}</div>
    </div>
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={title}
      disabled={disabled}
      className={clsx(styles.switchBtn, checked && styles.switchOn)}
      onClick={onToggle}
    >
      <span className={styles.switchThumb} />
    </button>
  </div>
)

/* =========================== Tab 2: 访客 IP 管理 =========================== */

const VisitorsPanel = ({ onViewLogs }: { onViewLogs: (ip: string) => void }) => {
  const t = useTranslate()
  const [searchInput, setSearchInput] = useState('')
  const [search, setSearch] = useState('')
  const [visitors, setVisitors] = useState<AdminVisitor[]>([])
  const [loading, setLoading] = useState(true)
  const [editingIp, setEditingIp] = useState<string | null>(null)
  const [customLimitText, setCustomLimitText] = useState('')
  const [noteText, setNoteText] = useState('')
  const [busyIp, setBusyIp] = useState<string | null>(null)

  useEffect(() => {
    const timer = setTimeout(() => setSearch(searchInput.trim()), 250)
    return () => clearTimeout(timer)
  }, [searchInput])

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const data = await fetchAdminVisitors(search)
      setVisitors(data.visitors)
    } catch {
      showToast({ key: 'adminLoadFailed', type: 'error' })
    } finally {
      setLoading(false)
    }
  }, [search])

  useEffect(() => {
    void load()
  }, [load])

  const startEdit = (v: AdminVisitor) => {
    if (editingIp === v.ip) {
      setEditingIp(null)
      return
    }
    setEditingIp(v.ip)
    setCustomLimitText(v.customLimit === null ? '' : String(v.customLimit))
    setNoteText(v.note)
  }

  const saveRule = async (ip: string) => {
    const trimmed = customLimitText.trim()
    let dailyLimit: number | null = null
    if (trimmed !== '') {
      const n = Number(trimmed)
      if (!Number.isInteger(n) || n < 0 || n > 10000) {
        showToast({ key: 'adminSaveFailed', type: 'error' })
        return
      }
      dailyLimit = n
    }
    setBusyIp(ip)
    try {
      await updateAdminVisitorRule(ip, { dailyLimit, note: noteText })
      setEditingIp(null)
      showToast({ key: 'adminSaveSuccess' })
      await load()
    } catch {
      showToast({ key: 'adminSaveFailed', type: 'error' })
    } finally {
      setBusyIp(null)
    }
  }

  const toggleBlock = async (v: AdminVisitor) => {
    setBusyIp(v.ip)
    try {
      await updateAdminVisitorRule(v.ip, { blocked: !v.blocked })
      showToast({ key: 'adminSaveSuccess' })
      await load()
    } catch {
      showToast({ key: 'adminSaveFailed', type: 'error' })
    } finally {
      setBusyIp(null)
    }
  }

  const resetToday = async (ip: string) => {
    setBusyIp(ip)
    try {
      await resetAdminVisitorQuota(ip)
      showToast({ key: 'adminVisitorResetDone', params: { ip } })
      await load()
    } catch {
      showToast({ key: 'adminSaveFailed', type: 'error' })
    } finally {
      setBusyIp(null)
    }
  }

  return (
    <>
      <div className={styles.toolbar}>
        <input
          type="search"
          className={styles.searchInput}
          placeholder={t('adminVisitorSearchPlaceholder')}
          value={searchInput}
          onChange={(event) => setSearchInput(event.target.value)}
        />
        <Button size="s" variant="outlined" disabled={loading} onClick={() => void load()}>
          {t('adminRefresh')}
        </Button>
      </div>

      <div className={styles.scrollArea}>
        {loading && visitors.length === 0 ? (
          <div className={styles.emptyState}>{t('adminLoading')}</div>
        ) : visitors.length === 0 ? (
          <div className={styles.emptyState}>{t('adminVisitorEmpty')}</div>
        ) : (
          <div className={styles.visitorList}>
            {visitors.map((v) => {
              const busy = busyIp === v.ip
              return (
                <div key={v.ip} className={styles.visitorCard}>
                  <div className={styles.visitorTop}>
                    <div className={styles.visitorMeta}>
                      <span className={styles.ipText}>{v.ip}</span>
                      <span className={clsx(styles.tag, styles.tagBrand)}>
                        {t('adminVisitorTodayUsage', {
                          used: v.todayUsed,
                          limit: v.effectiveLimit,
                        })}
                      </span>
                      {v.customLimit !== null ? (
                        <span className={styles.tag}>
                          {t('adminVisitorCustomLimit', { limit: v.customLimit })}
                        </span>
                      ) : null}
                      {v.blocked ? (
                        <span className={clsx(styles.tag, styles.tagDanger)}>
                          {t('adminVisitorBlocked')}
                        </span>
                      ) : null}
                      {v.note ? <span className={styles.tag}>{v.note}</span> : null}
                    </div>
                    <div className={styles.visitorActions}>
                      <Button size="s" variant="outlined" onClick={() => onViewLogs(v.ip)}>
                        {t('adminVisitorViewLogs')}
                      </Button>
                      <Button
                        size="s"
                        variant="outlined"
                        disabled={busy || v.todayUsed === 0}
                        onClick={() => void resetToday(v.ip)}
                      >
                        {t('adminVisitorResetToday')}
                      </Button>
                      <Button size="s" variant="outlined" disabled={busy} onClick={() => startEdit(v)}>
                        {t('adminVisitorEditRule')}
                      </Button>
                      <Button
                        size="s"
                        variant={v.blocked ? 'outlined' : 'dangerOutlined'}
                        disabled={busy}
                        onClick={() => void toggleBlock(v)}
                      >
                        {t(v.blocked ? 'adminVisitorUnblock' : 'adminVisitorBlock')}
                      </Button>
                    </div>
                  </div>
                  <div className={styles.visitorSub}>
                    <span>
                      {t('adminVisitorTotalStats', {
                        messages: v.totalMessages,
                        sessions: v.sessionCount,
                      })}
                    </span>
                    <span>{formatDateTime(v.lastActiveAt)}</span>
                  </div>
                  {v.lastQuestion ? (
                    <div className={styles.visitorSnippet} title={v.lastQuestion}>
                      {v.lastQuestion}
                    </div>
                  ) : null}

                  {editingIp === v.ip ? (
                    <div className={styles.ruleEditor}>
                      <label className={styles.ruleField}>
                        <span>{t('adminVisitorCustomLimitLabel')}</span>
                        <input
                          type="number"
                          min={0}
                          max={10000}
                          className={styles.numberInput}
                          value={customLimitText}
                          onChange={(event) => setCustomLimitText(event.target.value)}
                        />
                      </label>
                      <label className={styles.ruleField}>
                        <span>{t('adminVisitorNoteLabel')}</span>
                        <input
                          type="text"
                          className={styles.textInput}
                          placeholder={t('adminVisitorNotePlaceholder')}
                          value={noteText}
                          onChange={(event) => setNoteText(event.target.value)}
                        />
                      </label>
                      <Button
                        size="s"
                        variant="primary"
                        disabled={busy}
                        onClick={() => void saveRule(v.ip)}
                      >
                        {t('confirm')}
                      </Button>
                      <Button size="s" variant="outlined" onClick={() => setEditingIp(null)}>
                        {t('cancel')}
                      </Button>
                    </div>
                  ) : null}
                </div>
              )
            })}
          </div>
        )}
      </div>
    </>
  )
}

/* =========================== Tab 3: 免登录会话记录 =========================== */

const LogsPanel = ({
  filterIp,
  onChangeFilterIp,
}: {
  filterIp: string
  onChangeFilterIp: (ip: string) => void
}) => {
  const t = useTranslate()
  const [filterSession, setFilterSession] = useState('')
  const [searchInput, setSearchInput] = useState('')
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(0)
  const [items, setItems] = useState<AdminGuestLog[]>([])
  const [total, setTotal] = useState(0)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [clearConfirmOpen, setClearConfirmOpen] = useState(false)

  useEffect(() => {
    const timer = setTimeout(() => {
      setSearch(searchInput.trim())
      setPage(0)
    }, 250)
    return () => clearTimeout(timer)
  }, [searchInput])

  useEffect(() => {
    setPage(0)
  }, [filterIp, filterSession])

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const data = await fetchAdminLogs({
        ip: filterIp || undefined,
        sessionId: filterSession || undefined,
        search: search || undefined,
        offset: page * LOGS_PAGE_SIZE,
        limit: LOGS_PAGE_SIZE,
      })
      setItems(data.items)
      setTotal(data.total)
      setSelectedId((prev) =>
        prev && data.items.some((i) => i.id === prev) ? prev : (data.items[0]?.id ?? null)
      )
    } catch {
      showToast({ key: 'adminLoadFailed', type: 'error' })
    } finally {
      setLoading(false)
    }
  }, [filterIp, filterSession, search, page])

  useEffect(() => {
    void load()
  }, [load])

  const selected = items.find((item) => item.id === selectedId) ?? null
  const totalPages = Math.max(1, Math.ceil(total / LOGS_PAGE_SIZE))

  const handleDeleteOne = async (id: string) => {
    try {
      await deleteAdminLog(id)
      showToast({ key: 'adminLogDeleted' })
      await load()
    } catch {
      showToast({ key: 'adminSaveFailed', type: 'error' })
    }
  }

  const handleClearAll = async () => {
    try {
      await clearAdminLogs()
      setClearConfirmOpen(false)
      showToast({ key: 'adminLogCleared' })
      await load()
    } catch {
      showToast({ key: 'adminSaveFailed', type: 'error' })
    }
  }

  return (
    <>
      <div className={styles.toolbar}>
        <input
          type="search"
          className={styles.searchInput}
          placeholder={t('adminLogSearchPlaceholder')}
          value={searchInput}
          onChange={(event) => setSearchInput(event.target.value)}
        />
        {filterIp ? (
          <span className={styles.filterChip}>
            <span>{t('adminLogFilterByIp', { ip: filterIp })}</span>
            <button
              type="button"
              className={styles.filterClear}
              onClick={() => onChangeFilterIp('')}
            >
              {t('adminLogClearFilter')}
            </button>
          </span>
        ) : null}
        {filterSession ? (
          <span className={styles.filterChip}>
            <span>{t('adminLogFilterBySession', { session: filterSession.slice(0, 14) })}</span>
            <button
              type="button"
              className={styles.filterClear}
              onClick={() => setFilterSession('')}
            >
              {t('adminLogClearFilter')}
            </button>
          </span>
        ) : null}
        <Button size="s" variant="outlined" disabled={loading} onClick={() => void load()}>
          {t('adminRefresh')}
        </Button>
        <Button
          size="s"
          variant="dangerOutlined"
          disabled={total === 0}
          onClick={() => setClearConfirmOpen(true)}
        >
          {t('adminLogClearAll')}
        </Button>
      </div>

      <div className={styles.logsSplit}>
        <div className={styles.logListPane}>
          <div className={styles.logListScroll}>
            {loading && items.length === 0 ? (
              <div className={styles.emptyState}>{t('adminLoading')}</div>
            ) : items.length === 0 ? (
              <div className={styles.emptyState}>{t('adminLogEmpty')}</div>
            ) : (
              items.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className={clsx(styles.logItem, item.id === selectedId && styles.logItemActive)}
                  onClick={() => setSelectedId(item.id)}
                >
                  <div className={styles.logItemHead}>
                    <span className={styles.logItemIp}>{item.ip}</span>
                    <span>{formatDateTime(item.createdAt)}</span>
                  </div>
                  <div className={styles.logItemPrompt}>
                    {item.userContent ||
                      (item.attachments.length > 0 ? `[${item.attachments.join(', ')}]` : '—')}
                  </div>
                  <div className={styles.logItemTags}>
                    {item.search ? (
                      <span className={clsx(styles.tag, styles.tagBrand)}>
                        {t('adminLogTagSearch')}
                      </span>
                    ) : null}
                    {item.thinking ? (
                      <span className={styles.tag}>{t('adminLogTagThink')}</span>
                    ) : null}
                    {item.attachments.length > 0 ? (
                      <span className={styles.tag}>
                        {t('adminLogAttachments')} ×{item.attachments.length}
                      </span>
                    ) : null}
                    {item.status === 'error' ? (
                      <span className={clsx(styles.tag, styles.tagDanger)}>
                        {t('adminLogStatusError')}
                      </span>
                    ) : item.status === 'stopped' ? (
                      <span className={styles.tag}>{t('adminLogStatusStopped')}</span>
                    ) : null}
                  </div>
                </button>
              ))
            )}
          </div>
          <div className={styles.logPager}>
            <span>{total.toLocaleString()}</span>
            <div className={styles.visitorActions}>
              <Button
                size="s"
                variant="outlined"
                disabled={page <= 0 || loading}
                onClick={() => setPage((p) => Math.max(0, p - 1))}
              >
                {t('previewPrevPage')}
              </Button>
              <span>
                {page + 1} / {totalPages}
              </span>
              <Button
                size="s"
                variant="outlined"
                disabled={page >= totalPages - 1 || loading}
                onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
              >
                {t('previewNextPage')}
              </Button>
            </div>
          </div>
        </div>

        <div className={styles.logDetailPane}>
          {!selected ? (
            <div className={styles.emptyState}>{t('adminLogSelectHint')}</div>
          ) : (
            <>
              <div className={styles.detailHeader}>
                <div className={styles.detailTop}>
                  <div className={styles.visitorMeta}>
                    <span className={styles.ipText}>{selected.ip}</span>
                    <span className={styles.tag}>{selected.model}</span>
                    <span
                      className={clsx(
                        styles.tag,
                        selected.status === 'error' && styles.tagDanger
                      )}
                    >
                      {t(
                        selected.status === 'error'
                          ? 'adminLogStatusError'
                          : selected.status === 'stopped'
                            ? 'adminLogStatusStopped'
                            : 'adminLogStatusDone'
                      )}
                    </span>
                  </div>
                  <div className={styles.visitorActions}>
                    {filterSession !== selected.sessionId ? (
                      <Button
                        size="s"
                        variant="outlined"
                        onClick={() => setFilterSession(selected.sessionId)}
                      >
                        {t('adminLogViewSession')}
                      </Button>
                    ) : null}
                    <Button
                      size="s"
                      variant="dangerOutlined"
                      onClick={() => void handleDeleteOne(selected.id)}
                    >
                      {t('delete')}
                    </Button>
                  </div>
                </div>
                <div className={styles.detailMetaRow}>
                  <span>{formatDateTime(selected.createdAt)}</span>
                  {selected.inputTokens !== null || selected.outputTokens !== null ? (
                    <span>
                      {t('adminLogTokens', {
                        input: (selected.inputTokens ?? 0).toLocaleString(),
                        output: (selected.outputTokens ?? 0).toLocaleString(),
                      })}
                    </span>
                  ) : null}
                  {selected.userAgent ? <span title={selected.userAgent}>UA: {selected.userAgent.slice(0, 48)}</span> : null}
                </div>
              </div>

              <div className={styles.detailScroll}>
                {selected.attachments.length > 0 ? (
                  <div className={styles.sectionBlock}>
                    <div className={styles.sectionTitle}>{t('adminLogAttachments')}</div>
                    <div className={styles.visitorMeta}>
                      {selected.attachments.map((name, idx) => (
                        <span key={`${name}-${idx}`} className={clsx(styles.tag, styles.tagBrand)}>
                          {name}
                        </span>
                      ))}
                    </div>
                  </div>
                ) : null}

                <div className={styles.sectionBlock}>
                  <div className={styles.sectionTitle}>{t('adminLogUserQuestion')}</div>
                  <div className={styles.promptBox}>{selected.userContent || '—'}</div>
                </div>

                {selected.assistantThinking ? (
                  <details className={styles.thinkingDetails}>
                    <summary>{t('adminLogAssistantThinking')}</summary>
                    <div className={styles.thinkingBody}>{selected.assistantThinking}</div>
                  </details>
                ) : null}

                {selected.errorMessage ? (
                  <div className={styles.errorBox}>{selected.errorMessage}</div>
                ) : null}

                <div className={styles.sectionBlock}>
                  <div className={styles.sectionTitle}>{t('adminLogAssistantReply')}</div>
                  <div className={styles.replyBox}>
                    {selected.assistantContent ? (
                      <Markdown
                        content={selected.assistantContent}
                        loading={false}
                        cacheKey={`admin-log-${selected.id}`}
                        disableLink={false}
                      />
                    ) : (
                      <span>{t('adminLogNoReply')}</span>
                    )}
                  </div>
                </div>
              </div>
            </>
          )}
        </div>
      </div>

      {clearConfirmOpen ? (
        <Modal
          title={t('adminLogClearAllConfirmTitle')}
          onClose={() => setClearConfirmOpen(false)}
          footer={
            <>
              <Button variant="outlined" onClick={() => setClearConfirmOpen(false)}>
                {t('cancel')}
              </Button>
              <Button variant="danger" onClick={() => void handleClearAll()}>
                {t('delete')}
              </Button>
            </>
          }
        >
          {t('adminLogClearAllConfirmDesc')}
        </Modal>
      ) : null}
    </>
  )
}
