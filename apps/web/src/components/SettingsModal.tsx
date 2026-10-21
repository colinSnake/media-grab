import { Check, LoaderCircle, ShieldCheck, Trash2, UserRound, X } from 'lucide-react'
import type { AccountPlatform, AccountSummary, AppConfigPatch, DownloadMode } from '@mediagrab/shared'
import { modeOptions } from '../lib/options'

interface SettingsModalProps {
  open: boolean
  draft: AppConfigPatch
  onDraftChange: (patch: AppConfigPatch) => void
  accounts: AccountSummary[]
  activeAccountPlatform: AccountPlatform
  onAccountPlatformChange: (platform: AccountPlatform) => void
  accountCookie: string
  isSavingAccount: boolean
  onAccountCookieChange: (value: string) => void
  onSave: () => void
  onClose: () => void
  onSaveAccount: () => void
  onActivateAccount: (id: string) => void
  onVerifyAccount: (id: string) => void
  onDeleteAccount: (id: string) => void
  douyinCookieConfigured: boolean
  douyinCookie: string
  isSavingDouyinCookie: boolean
  onDouyinCookieChange: (value: string) => void
  onSaveDouyinCookie: () => void
  onClearDouyinCookie: () => void
  xiaohongshuCookieConfigured: boolean
  xiaohongshuCookie: string
  isSavingXiaohongshuCookie: boolean
  onXiaohongshuCookieChange: (value: string) => void
  onSaveXiaohongshuCookie: () => void
  onClearXiaohongshuCookie: () => void
}

export function SettingsModal({
  open,
  draft,
  onDraftChange,
  accounts,
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
  douyinCookieConfigured,
  douyinCookie,
  isSavingDouyinCookie,
  onDouyinCookieChange,
  onSaveDouyinCookie,
  onClearDouyinCookie,
  xiaohongshuCookieConfigured,
  xiaohongshuCookie,
  isSavingXiaohongshuCookie,
  onXiaohongshuCookieChange,
  onSaveXiaohongshuCookie,
  onClearXiaohongshuCookie,
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
            <label className="field-label">下载目录<input value={draft.savePath ?? ''} onChange={(event) => onDraftChange({ savePath: event.target.value })} /></label>
            <label className="field-label">yt-dlp 可执行文件<input placeholder="自动查找 yt-dlp" value={draft.ytDlpPath ?? ''} onChange={(event) => onDraftChange({ ytDlpPath: event.target.value })} /></label>
            <label className="field-label">默认输出<select value={draft.defaultDownloadMode ?? 'video+audio'} onChange={(event) => onDraftChange({ defaultDownloadMode: event.target.value as DownloadMode })}>{modeOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
          </div>
          <div className="account-section">
          <div className="account-platform-tabs" role="tablist" aria-label="平台账号">
            {([
              ['bilibili', 'B站'],
              ['douyin', '抖音'],
              ['xiaohongshu', '小红书'],
            ] as const).map(([platform, label]) => <button key={platform} type="button" role="tab" aria-selected={activeAccountPlatform === platform} className={activeAccountPlatform === platform ? 'active' : ''} onClick={() => onAccountPlatformChange(platform)}>{label}</button>)}
          </div>
          {activeAccountPlatform === 'bilibili' && <div className="platform-account-panel">
          <div className="account-section-heading"><div><h3><UserRound /> B站</h3></div></div>
          {accounts.filter((account) => account.platform === 'bilibili').length > 0 && <div className="account-list">{accounts.filter((account) => account.platform === 'bilibili').map((account) => <div className={`account-row ${account.active ? 'active' : ''}`} key={account.id}>
            <span className="account-avatar"><UserRound /></span>
            <span className="account-copy"><strong>{account.displayName || account.label}</strong><small>{account.active ? '当前使用' : account.status === 'active' ? '已验证' : '需要重新登录'}{account.vip ? ' · 大会员' : ''}</small></span>
            {!account.active && <button className="account-action" type="button" title="切换账号" onClick={() => onActivateAccount(account.id)}><ShieldCheck /></button>}
            <button className="account-action" type="button" title="验证账号" onClick={() => onVerifyAccount(account.id)}><Check /></button>
            <button className="account-action danger" type="button" title="删除账号" onClick={() => onDeleteAccount(account.id)}><Trash2 /></button>
          </div>)}</div>}
          <label className="field-label">B站 Cookie<textarea className="account-cookie-input" value={accountCookie} onChange={(event) => onAccountCookieChange(event.target.value)} placeholder="粘贴 B站 Cookie，需包含 SESSDATA" /></label>
          <div className="platform-cookie-actions"><button className="account-import-button" type="button" onClick={onSaveAccount} disabled={isSavingAccount || accountCookie.trim() === ''}>{isSavingAccount ? <LoaderCircle className="spin" /> : <ShieldCheck />}<span>{isSavingAccount ? '正在保存' : '保存'}</span></button></div>
          </div>}
          {activeAccountPlatform === 'douyin' && <div className="platform-account-panel">
            <div className="account-section-heading"><div><h3><UserRound /> 抖音</h3></div></div>
            <label className="field-label">抖音 Cookie<textarea className="account-cookie-input" value={douyinCookie} onChange={(event) => onDouyinCookieChange(event.target.value)} placeholder="粘贴 Cookie 请求头，或 Netscape Cookie 文件内容" /></label>
            <div className="platform-cookie-actions">
              <button className="account-import-button" type="button" onClick={onSaveDouyinCookie} disabled={isSavingDouyinCookie || douyinCookie.trim() === ''}>{isSavingDouyinCookie ? <LoaderCircle className="spin" /> : <ShieldCheck />}<span>{isSavingDouyinCookie ? '正在保存' : '保存'}</span></button>
              {douyinCookieConfigured && <button className="account-action danger" type="button" title="清除抖音 Cookie" aria-label="清除抖音 Cookie" onClick={onClearDouyinCookie}><Trash2 /></button>}
            </div>
          </div>}
          {activeAccountPlatform === 'xiaohongshu' && <div className="platform-account-panel">
            <div className="account-section-heading"><div><h3><UserRound /> 小红书</h3></div></div>
            <label className="field-label">小红书 Cookie<textarea className="account-cookie-input" value={xiaohongshuCookie} onChange={(event) => onXiaohongshuCookieChange(event.target.value)} placeholder="粘贴 Cookie 请求头，或 Netscape Cookie 文件内容" /></label>
            <div className="platform-cookie-actions">
              <button className="account-import-button" type="button" onClick={onSaveXiaohongshuCookie} disabled={isSavingXiaohongshuCookie || xiaohongshuCookie.trim() === ''}>{isSavingXiaohongshuCookie ? <LoaderCircle className="spin" /> : <ShieldCheck />}<span>{isSavingXiaohongshuCookie ? '正在保存' : '保存'}</span></button>
              {xiaohongshuCookieConfigured && <button className="account-action danger" type="button" title="清除小红书 Cookie" aria-label="清除小红书 Cookie" onClick={onClearXiaohongshuCookie}><Trash2 /></button>}
            </div>
          </div>}
          </div>
        </div>
        <div className="modal-footer"><button className="primary-button" type="button" onClick={onSave}><Check /><span>保存设置</span></button></div>
      </section>
    </div>
  )
}
