import { Check, LoaderCircle, ShieldCheck, Trash2, UserRound, X } from 'lucide-react'
import type { AccountPlatform, AccountSummary, AppConfigPatch, BrowserCookieSource, DownloadMode } from '@mediagrab/shared'
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
          {activeAccountPlatform === 'bilibili' && <>
          <div className="account-section-heading"><div><h3><UserRound /> B站账号</h3></div></div>
          {accounts.filter((account) => account.platform === 'bilibili').length > 0 && <div className="account-list">{accounts.filter((account) => account.platform === 'bilibili').map((account) => <div className={`account-row ${account.active ? 'active' : ''}`} key={account.id}>
            <span className="account-avatar"><UserRound /></span>
            <span className="account-copy"><strong>{account.displayName || account.label}</strong><small>{account.active ? '当前使用' : account.status === 'active' ? '已验证' : '需要重新登录'}{account.vip ? ' · 大会员' : ''}</small></span>
            {!account.active && <button className="account-action" type="button" title="切换账号" onClick={() => onActivateAccount(account.id)}><ShieldCheck /></button>}
            <button className="account-action" type="button" title="验证账号" onClick={() => onVerifyAccount(account.id)}><Check /></button>
            <button className="account-action danger" type="button" title="删除账号" onClick={() => onDeleteAccount(account.id)}><Trash2 /></button>
          </div>)}</div>}
          <label className="field-label">Cookie<textarea className="account-cookie-input" value={accountCookie} onChange={(event) => onAccountCookieChange(event.target.value)} placeholder="粘贴 B站 Cookie，需包含 SESSDATA" /></label>
          <button className="account-import-button" type="button" onClick={onSaveAccount} disabled={isSavingAccount || accountCookie.trim() === ''}>{isSavingAccount ? <LoaderCircle className="spin" /> : <ShieldCheck />}<span>{isSavingAccount ? '正在验证' : '导入并验证 B站账号'}</span></button>
          </>}
          {activeAccountPlatform === 'douyin' && <div className="platform-account-panel">
            <div className="account-section-heading"><div><h3><UserRound /> 抖音</h3></div></div>
            <label className="field-label">浏览器 Cookie 来源<select value={draft.douyinCookieBrowser ?? ''} onChange={(event) => onDraftChange({ douyinCookieBrowser: event.target.value as BrowserCookieSource })}>
              <option value="">不读取浏览器 Cookie</option>
              <option value="chrome">Chrome</option><option value="chromium">Chromium</option><option value="brave">Brave</option><option value="edge">Microsoft Edge</option><option value="firefox">Firefox</option><option value="opera">Opera</option><option value="safari">Safari</option><option value="vivaldi">Vivaldi</option><option value="whale">Whale</option>
            </select></label>
            <p className="platform-account-note">用于 yt-dlp 读取所选浏览器中的抖音 Cookie。部分公开内容也可不登录解析。</p>
          </div>}
          {activeAccountPlatform === 'xiaohongshu' && <div className="platform-account-panel">
            <div className="account-section-heading"><div><h3><UserRound /> 小红书</h3></div></div>
            <p className="platform-account-note">当前通过 yt-dlp 解析公开笔记，无需配置账号。登录态及账号 Cookie 尚未接入。</p>
          </div>}
          </div>
        </div>
        <div className="modal-footer"><button className="primary-button" type="button" onClick={onSave}><Check /><span>保存设置</span></button></div>
      </section>
    </div>
  )
}
