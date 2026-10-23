import { Check, FolderOpen, LoaderCircle, ShieldCheck, Trash2, UserRound, X } from 'lucide-react'
import type { AccountPlatform, AccountSummary, AppConfigPatch, CookieAccountPlatform, CookieStatus, DownloadMode } from '@mediagrab/shared'
import { modeOptions } from '../lib/options'
import { platformLabel } from '@mediagrab/shared'
import { PlatformLogo } from './PlatformLogo'

type SettingsAccountPlatform = AccountPlatform | 'youtube'
type CookieAccountState = CookieStatus & { cookie: string; saving: boolean }

interface SettingsModalProps {
  open: boolean
  draft: AppConfigPatch
  isSavingSettings: boolean
  onDraftChange: (patch: AppConfigPatch) => void
  onPickDownloadDirectory?: () => void
  accounts: AccountSummary[]
  accountAction: { id: string; action: 'activate' | 'verify' | 'delete' | 'clear-cookie' } | null
  activeAccountPlatform: SettingsAccountPlatform
  onAccountPlatformChange: (platform: SettingsAccountPlatform) => void
  accountCookie: string
  isSavingAccount: boolean
  onAccountCookieChange: (value: string) => void
  onSave: () => void
  onClose: () => void
  onSaveAccount: () => void
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
  isSavingSettings,
  onDraftChange,
  onPickDownloadDirectory,
  accounts,
  accountAction,
  activeAccountPlatform,
  onAccountPlatformChange,
  accountCookie,
  isSavingAccount,
  onAccountCookieChange,
  onSave,
  onClose,
  onSaveAccount,
  onActivateAccount,
  onVerifyAccount,
  onDeleteAccount,
  cookieAccounts,
  onCookieChange,
  onSaveCookie,
  onClearCookie,
}: SettingsModalProps) {
  if (!open) return null

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
                <input value={draft.savePath ?? ''} onChange={(event) => onDraftChange({ savePath: event.target.value })} />
                {onPickDownloadDirectory && <button type="button" onClick={onPickDownloadDirectory} title="选择下载目录" aria-label="选择下载目录"><FolderOpen /></button>}
              </span>
            </label>
            <label className="field-label">yt-dlp 可执行文件<input placeholder="自动查找 yt-dlp" value={draft.ytDlpPath ?? ''} onChange={(event) => onDraftChange({ ytDlpPath: event.target.value })} /></label>
            <label className="field-label">默认输出<select value={draft.defaultDownloadMode ?? 'video+audio'} onChange={(event) => onDraftChange({ defaultDownloadMode: event.target.value as Exclude<DownloadMode, 'image'> })}>{modeOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
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
          <div className="account-section-heading"><div><h3><UserRound /> B站</h3></div></div>
          {accounts.filter((account) => account.platform === 'bilibili').length > 0 && <div className="account-list">{accounts.filter((account) => account.platform === 'bilibili').map((account) => {
            const busy = accountAction?.id === account.id
            return <div className={`account-row ${account.active ? 'active' : ''}`} key={account.id}>
            <span className="account-avatar"><UserRound /></span>
            <span className="account-copy"><strong>{account.displayName || account.label}</strong><small>{account.active ? '当前使用' : account.status === 'active' ? '已验证' : '需要重新登录'}{account.vip ? ' · 大会员' : ''}</small></span>
            {!account.active && <button className="account-action" type="button" title="切换账号" aria-label="切换账号" aria-busy={busy && accountAction?.action === 'activate'} onClick={() => onActivateAccount(account.id)} disabled={accountAction !== null || isSavingAccount}>{busy && accountAction?.action === 'activate' ? <LoaderCircle className="spin" /> : <ShieldCheck />}</button>}
            <button className="account-action" type="button" title="验证账号" aria-label="验证账号" aria-busy={busy && accountAction?.action === 'verify'} onClick={() => onVerifyAccount(account.id)} disabled={accountAction !== null || isSavingAccount}>{busy && accountAction?.action === 'verify' ? <LoaderCircle className="spin" /> : <Check />}</button>
            <button className="account-action danger" type="button" title="删除账号" aria-label="删除账号" aria-busy={busy && accountAction?.action === 'delete'} onClick={() => onDeleteAccount(account.id)} disabled={accountAction !== null || isSavingAccount}>{busy && accountAction?.action === 'delete' ? <LoaderCircle className="spin" /> : <Trash2 />}</button>
          </div>})}</div>}
          <label className="field-label">B站 Cookie<textarea className="account-cookie-input" value={accountCookie} onChange={(event) => onAccountCookieChange(event.target.value)} placeholder="粘贴 B站 Cookie，需包含 SESSDATA" /></label>
          <div className="platform-cookie-actions"><button className="account-import-button" type="button" onClick={onSaveAccount} disabled={isSavingAccount || accountCookie.trim() === ''} aria-busy={isSavingAccount}>{isSavingAccount ? <LoaderCircle className="spin" /> : <ShieldCheck />}<span>{isSavingAccount ? '正在保存' : '保存'}</span></button></div>
          </div>}
          {(activeAccountPlatform === 'douyin' || activeAccountPlatform === 'xiaohongshu') && (() => {
            const platform = activeAccountPlatform
            const account = cookieAccounts[platform]
            return <div className="platform-account-panel">
              <div className="account-section-heading"><div><h3><PlatformLogo platform={platform} /> {platformLabel[platform]}</h3></div></div>
              <label className="field-label">{platformLabel[platform]} Cookie<textarea className="account-cookie-input" value={account.cookie} onChange={(event) => onCookieChange(platform, event.target.value)} placeholder="粘贴 Cookie 请求头，或 Netscape Cookie 文件内容" /></label>
              <div className="platform-cookie-actions">
                <button className="account-import-button" type="button" onClick={() => onSaveCookie(platform)} disabled={account.saving || account.cookie.trim() === ''} aria-busy={account.saving}>{account.saving ? <LoaderCircle className="spin" /> : <ShieldCheck />}<span>{account.saving ? '正在保存' : '保存'}</span></button>
                {account.configured && <button className="account-action danger" type="button" title={`清除${platformLabel[platform]} Cookie`} aria-label={`清除${platformLabel[platform]} Cookie`} aria-busy={accountAction?.id === `cookie:${platform}`} onClick={() => onClearCookie(platform)} disabled={accountAction !== null || account.saving}>{accountAction?.id === `cookie:${platform}` && accountAction.action === 'clear-cookie' ? <LoaderCircle className="spin" /> : <Trash2 />}</button>}
              </div>
            </div>
          })()}
          {activeAccountPlatform === 'youtube' && <div className="platform-account-panel">
            <div className="account-section-heading"><div><h3><PlatformLogo platform="youtube" /> YouTube</h3></div></div>
            <p className="platform-account-note">YouTube 当前通过 yt-dlp 解析公开内容，无需在这里配置账号 Cookie。</p>
          </div>}
          </div>
        </div>
        <div className="modal-footer"><button className="primary-button" type="button" onClick={onSave} disabled={isSavingSettings} aria-busy={isSavingSettings}>{isSavingSettings ? <LoaderCircle className="spin" /> : <Check />}<span>{isSavingSettings ? '正在保存' : '保存设置'}</span></button></div>
      </section>
    </div>
  )
}
