import { Check, FolderOpen, LoaderCircle, ShieldCheck, Trash2, UserRound, UsersRound, X } from 'lucide-react'
import type { AccountPlatform, AccountSummary, AppConfigPatch, CookieAccountPlatform, CookieStatus, DownloadMode } from '@mediagrab/shared'
import { modeOptions } from '../lib/options'
import { platformLabel } from '@mediagrab/shared'
import { PlatformLogo } from './PlatformLogo'

type SettingsAccountPlatform = AccountPlatform | 'youtube'
type CookieAccountState = CookieStatus & { cookie: string; saving: boolean }
type SettingField = 'savePath' | 'ytDlpPath' | 'defaultDownloadMode'

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
  isSavingAccount: boolean
  onAccountCookieChange: (value: string) => void
  onClose: () => void
  onSaveAccount: () => void
  onClearBiliCookie: () => void
  onActivateAccount: (id: string) => void
  onVerifyAccount: (id: string) => void
  onDeleteAccount: (id: string) => void
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
  isSavingAccount,
  onAccountCookieChange,
  onClose,
  onSaveAccount,
  onClearBiliCookie,
  onActivateAccount,
  onVerifyAccount,
  onDeleteAccount,
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
          <div className="account-section-heading"><div><h3><UserRound /> B站</h3></div>{activeBiliAccount && <button className="account-action" type="button" title="验证B站 Cookie" aria-label="验证B站 Cookie" aria-busy={accountAction?.id === activeBiliAccount.id && accountAction.action === 'verify'} onClick={() => onVerifyAccount(activeBiliAccount.id)} disabled={accountAction !== null || isSavingAccount}>{accountAction?.id === activeBiliAccount.id && accountAction.action === 'verify' ? <LoaderCircle className="spin" /> : <Check />}</button>}</div>
          <label className="field-label">B站鉴权信息<textarea className="account-cookie-input" value={accountCookie} onChange={(event) => onAccountCookieChange(event.target.value)} placeholder="粘贴B站 Cookie" autoComplete="off" spellCheck={false} /></label>
          <div className="platform-cookie-actions"><button className="account-import-button" type="button" onClick={onSaveAccount} disabled={isSavingAccount || accountAction !== null || accountCookie.trim() === ''} aria-busy={isSavingAccount}>{isSavingAccount ? '正在保存' : '保存'}</button><button className="account-clear-button" type="button" onClick={onClearBiliCookie} disabled={isSavingAccount || accountAction !== null || (!activeBiliAccount && accountCookie === '')} aria-busy={isClearingBili}>{isClearingBili ? '正在清空' : '清空'}</button></div>
          {accounts.filter((account) => account.platform === 'bilibili').length > 1 && <details className="account-management"><summary><UsersRound /> 管理已保存账号</summary><div className="account-list">{accounts.filter((account) => account.platform === 'bilibili').map((account) => <div className={`account-row ${account.active ? 'active' : ''}`} key={account.id}><span className="account-avatar"><UserRound /></span><span className="account-copy"><strong>{account.displayName || account.label}</strong><small>{account.active ? '当前使用' : account.status === 'active' ? '已验证' : '需要重新登录'}</small></span>{!account.active && <button className="account-action" type="button" title="切换账号" aria-label={`切换到${account.displayName || account.label}`} onClick={() => onActivateAccount(account.id)} disabled={accountAction !== null || isSavingAccount}>{accountAction?.id === account.id && accountAction.action === 'activate' ? <LoaderCircle className="spin" /> : <ShieldCheck />}</button>}{!account.active && <button className="account-action danger" type="button" title="删除账号" aria-label={`删除${account.displayName || account.label}`} onClick={() => onDeleteAccount(account.id)} disabled={accountAction !== null || isSavingAccount}>{accountAction?.id === account.id && accountAction.action === 'delete' ? <LoaderCircle className="spin" /> : <Trash2 />}</button>}</div>)}</div></details>}
          </div>}
          {(activeAccountPlatform === 'douyin' || activeAccountPlatform === 'xiaohongshu' || activeAccountPlatform === 'youtube') && (() => {
            const platform = activeAccountPlatform
            const account = cookieAccounts[platform]
            return <div className="platform-account-panel">
              <div className="account-section-heading"><div><h3><PlatformLogo platform={platform} /> {platformLabel[platform]}</h3></div></div>
              <label className="field-label">{platformLabel[platform]}鉴权信息<textarea className="account-cookie-input" value={account.cookie} onChange={(event) => onCookieChange(platform, event.target.value)} placeholder={`粘贴${platformLabel[platform]} Cookie`} autoComplete="off" spellCheck={false} /></label>
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
