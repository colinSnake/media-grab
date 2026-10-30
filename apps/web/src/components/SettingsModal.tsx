import { Check, FolderOpen, LoaderCircle, UserRound, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { AccountPlatform, AccountSummary, AppConfigPatch, CookieAccountPlatform, CookieStatus, DownloadMode } from '@mediagrab/shared'
import { modeOptions } from '../lib/options'
import { platformLabel } from '@mediagrab/shared'
import { PlatformLogo } from './PlatformLogo'
import { encryptCookieForDisplay } from '../lib/cookie-encryption'

type SettingsAccountPlatform = AccountPlatform | 'youtube'
type CookieAccountState = CookieStatus & { cookie: string; saving: boolean; authFailed: boolean }
type SettingField = 'savePath' | 'ytDlpPath' | 'defaultDownloadMode'

function CookieInput({ platform, cookie, credentialPreview, disabled, onChange }: {
  platform: string
  cookie: string
  credentialPreview?: string | null
  disabled: boolean
  onChange: (value: string) => void
}) {
  const [dismissedPreview, setDismissedPreview] = useState<string | null>(null)
  const [draftCiphertext, setDraftCiphertext] = useState('')
  const [encryptionFailed, setEncryptionFailed] = useState(false)
  const [draftRevision, setDraftRevision] = useState(0)
  useEffect(() => {
    let active = true
    setDraftCiphertext('')
    setEncryptionFailed(false)
    if (cookie) {
      void encryptCookieForDisplay(cookie).then((ciphertext) => {
        if (active) setDraftCiphertext(ciphertext)
      }).catch(() => {
        if (active) setEncryptionFailed(true)
      })
    }
    return () => { active = false }
  }, [cookie, draftRevision])
  const displayValue = cookie
    ? draftCiphertext || (encryptionFailed ? '加密失败，请重新粘贴' : '正在加密')
    : credentialPreview && credentialPreview !== dismissedPreview ? credentialPreview : ''
  // Paste is intercepted so Cookie bytes never become the textarea's DOM value.
  return <textarea
    aria-label={`${platform} Cookie`}
    aria-description="粘贴后显示完整加密字符串，可以选中复制；点击保存后生效，粘贴新的 Cookie 可替换"
    className="account-cookie-input"
    value={displayValue}
    placeholder={`粘贴${platform} Cookie`}
    title={cookie ? '待保存，当前显示完整 JWE 密文' : credentialPreview ? '已加密保存，当前显示完整 JWE 密文，粘贴 Cookie 可替换' : undefined}
    onChange={(event) => {
      // Ciphertext is display-only: editing it must never submit it as a Cookie.
      // Keep the native editable caret and selection; replace credentials through paste/drop.
      event.currentTarget.value = displayValue
    }}
    disabled={disabled}
    onPaste={(event) => {
      event.preventDefault()
      if (!disabled) {
        setDismissedPreview(null)
        setDraftCiphertext('')
        setEncryptionFailed(false)
        setDraftRevision((current) => current + 1)
        onChange(event.clipboardData.getData('text/plain'))
      }
    }}
    onDragOver={(event) => event.preventDefault()}
    onDrop={(event) => {
      event.preventDefault()
      if (!disabled) {
        setDismissedPreview(null)
        setDraftCiphertext('')
        setEncryptionFailed(false)
        setDraftRevision((current) => current + 1)
        onChange(event.dataTransfer.getData('text/plain'))
      }
    }}
    onKeyDown={(event) => {
      if (event.key === 'Backspace' || event.key === 'Delete') {
        event.preventDefault()
        if (!disabled) {
          setDismissedPreview(credentialPreview ?? null)
          onChange('')
        }
      }
    }}
    autoComplete="off"
    spellCheck={false}
  />
}

interface SettingsModalProps {
  open: boolean
  draft: AppConfigPatch
  settingErrors: Partial<Record<SettingField, string>>
  onDraftChange: (patch: AppConfigPatch) => void
  onSaveSetting: (field: SettingField, value: string) => void
  onPickDownloadDirectory?: () => void
  accounts: AccountSummary[]
  accountAction: { id: string; action: 'activate' | 'verify' | 'delete' | 'clear-cookie' } | null
  activeAccountPlatform: SettingsAccountPlatform
  onAccountPlatformChange: (platform: SettingsAccountPlatform) => void
  accountCookie: string
  biliAuthFailed: boolean
  isSavingAccount: boolean
  onAccountCookieChange: (value: string) => void
  onClose: () => void
  onSaveAccount: () => void
  onClearBiliCookie: () => void
  onVerifyAccount: (id: string) => void
  cookieAccounts: Record<CookieAccountPlatform, CookieAccountState>
  onCookieChange: (platform: CookieAccountPlatform, value: string) => void
  onSaveCookie: (platform: CookieAccountPlatform) => void
  onClearCookie: (platform: CookieAccountPlatform) => void
}

export function SettingsModal({
  open,
  draft,
  settingErrors,
  onDraftChange,
  onSaveSetting,
  onPickDownloadDirectory,
  accounts,
  accountAction,
  activeAccountPlatform,
  onAccountPlatformChange,
  accountCookie,
  biliAuthFailed,
  isSavingAccount,
  onAccountCookieChange,
  onClose,
  onSaveAccount,
  onClearBiliCookie,
  onVerifyAccount,
  cookieAccounts,
  onCookieChange,
  onSaveCookie,
  onClearCookie,
}: SettingsModalProps) {
  if (!open) return null
  const activeBiliAccount = accounts.find((account) => account.platform === 'bilibili' && account.active)
  const isClearingBili = accountAction?.action === 'delete' && accountAction.id === activeBiliAccount?.id

  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <section className="settings-modal" role="dialog" aria-modal="true" aria-labelledby="settings-title" onClick={(event) => event.stopPropagation()}>
        <div className="modal-heading">
          <div><h2 id="settings-title">应用设置</h2></div>
          <button className="icon-button" type="button" title="关闭" onClick={onClose}><X /></button>
        </div>
        <div className="settings-layout">
          <div className="settings-general">
            <label className="field-label">下载目录
              <span className="directory-picker">
                <input value={draft.savePath ?? ''} onChange={(event) => onDraftChange({ savePath: event.target.value })} onBlur={(event) => onSaveSetting('savePath', event.currentTarget.value)} aria-invalid={Boolean(settingErrors.savePath)} aria-describedby={settingErrors.savePath ? 'setting-save-path-error' : undefined} />
                {onPickDownloadDirectory && <button type="button" onClick={onPickDownloadDirectory} title="选择下载目录" aria-label="选择下载目录"><FolderOpen /></button>}
              </span>
              {settingErrors.savePath && <span id="setting-save-path-error" className="settings-field-error">{settingErrors.savePath}</span>}
            </label>
            <label className="field-label">yt-dlp 可执行文件<input placeholder="自动查找 yt-dlp" value={draft.ytDlpPath ?? ''} onChange={(event) => onDraftChange({ ytDlpPath: event.target.value })} onBlur={(event) => onSaveSetting('ytDlpPath', event.currentTarget.value)} aria-invalid={Boolean(settingErrors.ytDlpPath)} aria-describedby={settingErrors.ytDlpPath ? 'setting-ytdlp-error' : undefined} />{settingErrors.ytDlpPath && <span id="setting-ytdlp-error" className="settings-field-error">{settingErrors.ytDlpPath}</span>}</label>
            <label className="field-label">默认输出<select value={draft.defaultDownloadMode ?? 'video+audio'} onChange={(event) => onDraftChange({ defaultDownloadMode: event.target.value as Exclude<DownloadMode, 'image'> })} onBlur={(event) => onSaveSetting('defaultDownloadMode', event.currentTarget.value)} aria-invalid={Boolean(settingErrors.defaultDownloadMode)} aria-describedby={settingErrors.defaultDownloadMode ? 'setting-default-mode-error' : undefined}>{modeOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select>{settingErrors.defaultDownloadMode && <span id="setting-default-mode-error" className="settings-field-error">{settingErrors.defaultDownloadMode}</span>}</label>
          </div>
          <div className="account-section">
          <div className="account-platform-tabs" role="tablist" aria-label="平台账号">
            {([
              ['bilibili', 'B站'],
              ['douyin', '抖音'],
              ['xiaohongshu', '小红书'],
              ['youtube', 'YouTube'],
            ] as const).map(([platform, label]) => <button key={platform} type="button" role="tab" data-platform={platform} aria-selected={activeAccountPlatform === platform} className={activeAccountPlatform === platform ? 'active' : ''} onClick={() => onAccountPlatformChange(platform)}><PlatformLogo platform={platform} /><span>{label}</span></button>)}
          </div>
          {activeAccountPlatform === 'bilibili' && <div className="platform-account-panel">
          <div className="account-section-heading"><div><h3><UserRound /> B站</h3><span className={`auth-status ${biliAuthFailed ? 'failed' : activeBiliAccount?.status === 'active' ? 'success' : ''}`}>{biliAuthFailed ? '（认证失败，认证信息不对，请重试）' : activeBiliAccount?.status === 'active' ? '（认证成功，信息已加密处理）' : '（未认证）'}</span></div>{activeBiliAccount && <button className="account-action" type="button" title="验证B站 Cookie" aria-label="验证B站 Cookie" aria-busy={accountAction?.id === activeBiliAccount.id && accountAction.action === 'verify'} onClick={() => onVerifyAccount(activeBiliAccount.id)} disabled={accountAction !== null || isSavingAccount}>{accountAction?.id === activeBiliAccount.id && accountAction.action === 'verify' ? <LoaderCircle className="spin" /> : <Check />}</button>}</div>
          <CookieInput platform="B站" cookie={accountCookie} credentialPreview={activeBiliAccount?.credentialPreview} disabled={isSavingAccount || accountAction !== null} onChange={onAccountCookieChange} />
          <div className="platform-cookie-actions"><button className="account-import-button" type="button" onClick={onSaveAccount} disabled={isSavingAccount || accountAction !== null || accountCookie.trim() === ''} aria-busy={isSavingAccount}>{isSavingAccount ? '正在保存' : '保存'}</button><button className="account-clear-button" type="button" onClick={onClearBiliCookie} disabled={isSavingAccount || accountAction !== null || (!activeBiliAccount && accountCookie === '')} aria-busy={isClearingBili}>{isClearingBili ? '正在清空' : '清空'}</button></div>
          </div>}
          {(activeAccountPlatform === 'douyin' || activeAccountPlatform === 'xiaohongshu' || activeAccountPlatform === 'youtube') && (() => {
            const platform = activeAccountPlatform
            const account = cookieAccounts[platform]
            return <div className="platform-account-panel">
              <div className="account-section-heading"><div><h3><PlatformLogo platform={platform} /> {platformLabel[platform]}</h3><span className={`auth-status ${account.authFailed ? 'failed' : account.configured ? 'success' : ''}`}>{account.authFailed ? '（认证失败，认证信息不对，请重试）' : account.configured ? '（认证成功，信息已加密处理）' : '（未认证）'}</span></div></div>
              <CookieInput key={platform} platform={platformLabel[platform]} cookie={account.cookie} credentialPreview={account.credentialPreview} disabled={account.saving || accountAction !== null} onChange={(value) => onCookieChange(platform, value)} />
              <div className="platform-cookie-actions">
                <button className="account-import-button" type="button" onClick={() => onSaveCookie(platform)} disabled={accountAction !== null || account.saving || account.cookie.trim() === ''} aria-busy={account.saving}>{account.saving ? '正在保存' : '保存'}</button>
                <button className="account-clear-button" type="button" onClick={() => onClearCookie(platform)} disabled={accountAction !== null || account.saving || (!account.configured && account.cookie === '')} aria-busy={accountAction?.id === `cookie:${platform}` && accountAction.action === 'clear-cookie'}>{accountAction?.id === `cookie:${platform}` && accountAction.action === 'clear-cookie' ? '正在清空' : '清空'}</button>
              </div>
            </div>
          })()}
          </div>
        </div>
      </section>
    </div>
  )
}
