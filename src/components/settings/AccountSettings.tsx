import { useRef, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { logout, revokeOtherSessions, updateAvatar, useAuth } from '../../services/auth/store.js'
import { Button } from '../base/Button.js'
import { showToast } from '../base/toastState.js'
import { AvatarCropModal } from './AvatarCropModal.js'
import styles from './AccountSettings.module.css'

const ACCEPTED_AVATAR_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
const MAX_SOURCE_IMAGE_BYTES = 10 * 1024 * 1024

const getAvatarInitial = (name: string): string => {
  const trimmed = name.trim()
  if (!trimmed) {
    return 'A'
  }
  return Array.from(trimmed)[0]?.toUpperCase() ?? 'A'
}

const IconCameraOutline16 = () => (
  <svg width={16} height={16} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path
      d="M2.5 5.5C2.5 4.67157 3.17157 4 4 4H5.1L5.85 2.85C6.0355 2.5675 6.351 2.4 6.689 2.4H9.311C9.649 2.4 9.9645 2.5675 10.15 2.85L10.9 4H12C12.8284 4 13.5 4.67157 13.5 5.5V11.5C13.5 12.3284 12.8284 13 12 13H4C3.17157 13 2.5 12.3284 2.5 11.5V5.5Z"
      stroke="currentColor"
      strokeWidth={1.35}
      strokeLinejoin="round"
    />
    <circle cx={8} cy={8.5} r={2.25} stroke="currentColor" strokeWidth={1.35} />
  </svg>
)

/**
 * 账号分组：头像修改与裁切、当前账号、踢掉其他设备、退出登录。
 * 账号与口令由服务端 .env 决定，所以这里不提供注册、改密入口。
 */
export const AccountSettings = () => {
  const t = useTranslate()
  const user = useAuth((state) => state.user)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [cropFile, setCropFile] = useState<File | null>(null)
  const [savingAvatar, setSavingAvatar] = useState(false)
  const [revoking, setRevoking] = useState(false)

  const username = user?.username ?? ''
  const avatar = user?.avatar ?? null
  const initial = getAvatarInitial(username)

  const triggerFilePick = () => {
    if (savingAvatar) {
      return
    }
    fileInputRef.current?.click()
  }

  const onFileSelected = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) {
      return
    }
    if (!ACCEPTED_AVATAR_TYPES.has(file.type)) {
      showToast({ key: 'accountAvatarInvalidFile', type: 'error' })
      return
    }
    if (file.size > MAX_SOURCE_IMAGE_BYTES) {
      showToast({ key: 'accountAvatarTooLarge', type: 'error' })
      return
    }
    setCropFile(file)
  }

  const handleSaveAvatar = async (dataUrl: string) => {
    setSavingAvatar(true)
    const ok = await updateAvatar(dataUrl)
    setSavingAvatar(false)
    if (ok) {
      setCropFile(null)
      showToast({ key: 'accountAvatarSaved' })
    } else {
      showToast({ key: 'accountAvatarSaveFailed', type: 'error' })
    }
  }

  const handleResetAvatar = async () => {
    setSavingAvatar(true)
    const ok = await updateAvatar(null)
    setSavingAvatar(false)
    showToast(
      ok
        ? { key: 'accountAvatarResetDone' }
        : { key: 'accountAvatarSaveFailed', type: 'error' }
    )
  }

  const revokeOthers = async () => {
    setRevoking(true)
    const revoked = await revokeOtherSessions()
    setRevoking(false)
    showToast(
      revoked === null
        ? { key: 'accountLogoutOtherDevicesFailed', type: 'error' }
        : { key: 'accountLoggedOutOtherDevices', params: { count: revoked } }
    )
  }

  return (
    <div className={styles.panel}>
      <div className={`${styles.cell} ${styles.avatarCell}`}>
        <div className={styles.avatarRow}>
          <button
            type="button"
            className={`${styles.avatarPreview}${avatar ? ` ${styles.avatarPreviewCustom}` : ''}`}
            onClick={triggerFilePick}
            disabled={savingAvatar}
            aria-label={t('accountAvatarChange')}
          >
            {avatar ? (
              <img src={avatar} alt={username} className={styles.avatarImg} />
            ) : (
              <span className={styles.avatarInitial}>{initial}</span>
            )}
            <span className={styles.avatarOverlay} aria-hidden>
              <IconCameraOutline16 />
            </span>
          </button>
          <div className={styles.text}>
            <div className={styles.label}>{t('accountAvatarLabel')}</div>
            <div className={styles.description}>{t('accountAvatarDescription')}</div>
          </div>
        </div>
        <div className={styles.avatarActions}>
          <Button variant="outlined" size="m" disabled={savingAvatar} onClick={triggerFilePick}>
            {t('accountAvatarChange')}
          </Button>
          {avatar ? (
            <Button
              variant="outlined"
              size="m"
              disabled={savingAvatar}
              onClick={() => void handleResetAvatar()}
            >
              {t('accountAvatarReset')}
            </Button>
          ) : null}
        </div>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif"
          className={styles.hiddenInput}
          onChange={onFileSelected}
        />
      </div>

      <div className={styles.cell}>
        <div className={styles.text}>
          <div className={styles.label}>{t('accountSignedInAs', { username })}</div>
          <div className={styles.description}>{t('accountServerManaged')}</div>
        </div>
      </div>

      <div className={styles.cell}>
        <div className={styles.text}>
          <div className={styles.label}>{t('accountLogoutOtherDevices')}</div>
          <div className={styles.description}>{t('accountLogoutOtherDevicesDescription')}</div>
        </div>
        <Button variant="outlined" size="m" disabled={revoking} onClick={() => void revokeOthers()}>
          {t('accountLogoutOtherDevices')}
        </Button>
      </div>

      <div className={styles.cell}>
        <div className={styles.text}>
          <div className={styles.label}>{t('accountLogout')}</div>
        </div>
        <Button variant="dangerOutlined" size="m" onClick={() => void logout()}>
          {t('accountLogout')}
        </Button>
      </div>

      {cropFile ? (
        <AvatarCropModal
          file={cropFile}
          saving={savingAvatar}
          onCancel={() => setCropFile(null)}
          onConfirm={(dataUrl) => void handleSaveAvatar(dataUrl)}
        />
      ) : null}
    </div>
  )
}
