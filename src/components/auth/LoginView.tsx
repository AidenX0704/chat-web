import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { clearAuthError, login, useAuth } from '../../services/auth/store.js'
import { BrandMark } from '../base/BrandMark.js'
import { Button } from '../base/Button.js'
import { IconEyeOffOutline16, IconEyeOutline16 } from '../base/icons.js'
import styles from './LoginView.module.css'

/** 记住上次输入的用户名：个人使用只有这一个账号，省得每次重敲 */
const USERNAME_KEY = 'chat-personal:login-username'

const readRememberedUsername = (): string => {
  try {
    return localStorage.getItem(USERNAME_KEY) ?? ''
  } catch {
    // 隐私模式下 localStorage 不可用
    return ''
  }
}

const rememberUsername = (username: string): void => {
  try {
    localStorage.setItem(USERNAME_KEY, username)
  } catch {
    // 存不下就只当没记住，不影响登录
  }
}

/**
 * 登录页：访客点「登录」后替换整个界面；关掉后回到访客对话。
 * 服务端只有一个账号（凭据在 .env 里），所以这里没有注册入口，也不做用户名格式校验。
 */
export const LoginView = ({ onDismiss }: { onDismiss?: () => void } = {}) => {
  const t = useTranslate()
  const [username, setUsername] = useState(readRememberedUsername)
  const [password, setPassword] = useState('')
  const [revealed, setRevealed] = useState(false)
  const [capsLock, setCapsLock] = useState(false)
  const busy = useAuth((state) => state.busy)
  const error = useAuth((state) => state.error)
  const errorText = useAuth((state) => state.errorText)
  const usernameRef = useRef<HTMLInputElement>(null)
  const passwordRef = useRef<HTMLInputElement>(null)
  // 只有首屏焦点需要判断「用户名是否已预填」，之后不再跟随输入变化
  const prefill = useRef(username !== '')

  // 已经记住用户名时直接把光标放到密码框，少按一次 Tab
  useEffect(() => {
    const target = prefill.current ? passwordRef.current : usernameRef.current
    target?.focus()
  }, [])

  const resetError = () => {
    if (error || errorText) {
      clearAuthError()
    }
  }

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const name = username.trim()
    if (busy || name === '' || password === '') {
      return
    }
    if (await login(name, password)) {
      rememberUsername(name)
      setPassword('')
      setRevealed(false)
      return
    }
    // 失败时保留输入并全选密码，方便直接重敲
    passwordRef.current?.focus()
    passwordRef.current?.select()
  }

  const trackCapsLock = (event: KeyboardEvent<HTMLInputElement>) => {
    setCapsLock(event.getModifierState('CapsLock'))
  }

  return (
    <div className={styles.page}>
      <div className={styles.glow} aria-hidden="true" />
      <div className={styles.stack}>
        <form
          className={styles.card}
          onSubmit={(event) => void submit(event)}
          aria-busy={busy}
          noValidate
        >
          <div className={styles.brand}>
            <BrandMark size="login" />
          </div>

          <div className={styles.heading}>
            <h1 className={styles.title}>{t('loginPageTitle')}</h1>
            <p className={styles.subtitle}>{t('loginPageSubtitle')}</p>
          </div>

          <div className={styles.fields}>
            <label className={styles.field}>
              <span className={styles.label}>{t('loginUsername')}</span>
              <input
                ref={usernameRef}
                className={styles.input}
                name="username"
                value={username}
                autoComplete="username"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                placeholder={t('loginUsernamePlaceholder')}
                maxLength={64}
                disabled={busy}
                onChange={(event) => {
                  setUsername(event.target.value)
                  resetError()
                }}
              />
            </label>

            <label className={styles.field}>
              <span className={styles.label}>{t('loginPassword')}</span>
              <span className={styles.control}>
                <input
                  ref={passwordRef}
                  className={styles.input}
                  name="password"
                  type={revealed ? 'text' : 'password'}
                  value={password}
                  autoComplete="current-password"
                  placeholder={t('loginPasswordPlaceholder')}
                  maxLength={128}
                  disabled={busy}
                  onChange={(event) => {
                    setPassword(event.target.value)
                    resetError()
                  }}
                  onKeyDown={trackCapsLock}
                  onKeyUp={trackCapsLock}
                  onBlur={() => setCapsLock(false)}
                />
                <button
                  type="button"
                  className={styles.reveal}
                  aria-label={t(revealed ? 'loginPasswordHide' : 'loginPasswordShow')}
                  aria-pressed={revealed}
                  title={t(revealed ? 'loginPasswordHide' : 'loginPasswordShow')}
                  disabled={busy}
                  onClick={() => setRevealed(!revealed)}
                >
                  {revealed ? <IconEyeOffOutline16 /> : <IconEyeOutline16 />}
                </button>
              </span>
            </label>
          </div>

          {capsLock ? (
            <p className={styles.hint} role="status">
              {t('loginCapsLock')}
            </p>
          ) : null}

          {error || errorText ? (
            <div className={styles.error} role="alert">
              {error ? t(error.key, error.params) : errorText}
            </div>
          ) : null}

          <Button type="submit" block disabled={busy || username.trim() === '' || password === ''}>
            {t(busy ? 'loginSubmitting' : 'loginSubmit')}
          </Button>

          <p className={styles.footnote}>{t('loginPersonalOnly')}</p>

          {onDismiss ? (
            <button type="button" className={styles.dismiss} onClick={onDismiss}>
              {t('loginBackToGuest')}
            </button>
          ) : null}
        </form>
      </div>
    </div>
  )
}

/** 启动时校验登录态的占位，避免登录页闪一下 */
export const AuthLoadingView = () => {
  const t = useTranslate()
  return (
    <div className={styles.page}>
      <div className={styles.glow} aria-hidden="true" />
      <div className={styles.stack}>
        <div className={styles.card} role="status" aria-live="polite">
          <div className={styles.brand}>
            <BrandMark size="login" />
          </div>
          <div className={styles.loading}>
            <span className={styles.spinner} aria-hidden="true" />
            <span className={styles.subtitle}>{t('authLoading')}</span>
          </div>
        </div>
      </div>
    </div>
  )
}
