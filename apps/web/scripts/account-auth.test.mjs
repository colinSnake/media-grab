import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

let vite, SettingsModal, applyCookieStatus, invalidateAccount, request, RequestError, isAccountAuthenticationError
before(async () => {
  vite = await createServer({ root: fileURLToPath(new URL('../', import.meta.url)), configFile: false, appType: 'custom', logLevel: 'error', optimizeDeps: { noDiscovery: true, include: [] }, esbuild: { jsx: 'automatic' }, server: { middlewareMode: true, hmr: false, ws: false, watch: null } })
  ;({ SettingsModal } = await vite.ssrLoadModule('/src/components/SettingsModal.tsx'))
  ;({ applyCookieStatus, invalidateAccount } = await vite.ssrLoadModule('/src/lib/account-state.ts'))
  ;({ request, RequestError, isAccountAuthenticationError } = await vite.ssrLoadModule('/src/api.ts'))
})
after(async () => { await vite?.close() })

const credential = 'saved-encrypted-credential'
const account = { id: 'bili', platform: 'bilibili', label: '测试账号', displayName: '', status: 'active', loggedIn: true, vip: true, active: true, lastVerifiedAt: null, credentialPreview: credential }
const cookieState = { cookie: '', configured: true, credentialPreview: credential, saving: false, authFailed: false }
const props = {
  open: true, draft: {}, settingErrors: {}, accounts: [account], accountAction: null,
  activeAccountPlatform: 'bilibili', accountCookie: '', biliAuthFailed: false, isSavingAccount: false,
  cookieAccounts: { douyin: cookieState, xiaohongshu: cookieState, youtube: cookieState },
}
for (const callback of ['onDraftChange', 'onSaveSetting', 'onAccountPlatformChange', 'onAccountCookieChange', 'onClose', 'onSaveAccount', 'onClearBiliCookie', 'onVerifyAccount', 'onCookieChange', 'onSaveCookie', 'onClearCookie']) props[callback] = () => {}
const render = (patch = {}) => renderToStaticMarkup(createElement(SettingsModal, { ...props, ...patch }))
const cookieInput = (html) => html.match(/<textarea\b[^>]*class="account-cookie-input"[^>]*>(.*?)<\/textarea>/s)?.[1]

test('Bilibili expiration removes ciphertext from the actual settings input', () => {
  assert.equal(cookieInput(render()), credential)
  const expired = invalidateAccount(account)
  assert.equal(expired.credentialPreview, null)
  assert.equal(cookieInput(render({ accounts: [expired], biliAuthFailed: true })), '')
  // Even a stale response carrying ciphertext must not render an invalid account's credential.
  assert.equal(cookieInput(render({ accounts: [{ ...account, status: 'needs-login' }] })), '')
  assert.equal(cookieInput(render({ accounts: [{ ...account, status: 'invalid' }] })), '')
})

test('expired platform status clears the input across tabs and reopening', () => {
  for (const platform of ['douyin', 'xiaohongshu', 'youtube']) {
    assert.equal(cookieInput(render({ activeAccountPlatform: platform })), credential)
    const expired = applyCookieStatus(cookieState, { configured: false, credentialPreview: null })
    const patch = { activeAccountPlatform: platform, cookieAccounts: { ...props.cookieAccounts, [platform]: expired } }
    assert.equal(cookieInput(render(patch)), '')
    assert.equal(render({ ...patch, open: false }), '')
    assert.equal(cookieInput(render(patch)), '')
    assert.equal(cookieInput(render({ ...patch, cookieAccounts: { ...props.cookieAccounts, [platform]: { ...expired, credentialPreview: credential } } })), '')
  }
})

test('background expiration preserves a newly pasted replacement', () => {
  const current = { ...cookieState, cookie: 'sessionid=new-draft' }
  const next = applyCookieStatus(current, { configured: false, credentialPreview: null })
  assert.equal(next.cookie, current.cookie)
  assert.equal(next.credentialPreview, null)
  assert.equal(next.saving, false)
})

test('saved cookies are not misrepresented as verified authentication', () => {
  for (const platform of ['douyin', 'xiaohongshu', 'youtube']) {
    const html = render({ activeAccountPlatform: platform })
    assert.match(html, /已保存，信息已加密处理/)
    assert.doesNotMatch(html, /认证成功/)
  }
})

test('API preserves explicit auth codes and keeps network/rate-limit errors distinct', async (t) => {
  const originalFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = originalFetch })
  for (const code of ['ACCOUNT_NOT_LOGGED_IN', 'ACCOUNT_CREDENTIAL_MISSING', 'PLATFORM_RATE_LIMITED', 'CORE_AUTH_REQUIRED', 'MEDIA_PERMISSION_DENIED']) {
    globalThis.fetch = async () => new Response(JSON.stringify({ error: { code, kind: code.startsWith('ACCOUNT_') ? 'auth' : 'risk', message: '服务端文案可变化' } }), { status: 403 })
    await assert.rejects(request('/fixture'), (error) => {
      assert.ok(error instanceof RequestError)
      assert.equal(error.code, code)
      assert.equal(error.message, '服务端文案可变化')
      assert.equal(isAccountAuthenticationError(error), code.startsWith('ACCOUNT_'))
      return true
    })
  }
  globalThis.fetch = async () => { throw new Error('offline') }
  await assert.rejects(request('/fixture'), (error) => !isAccountAuthenticationError(error))
  globalThis.fetch = async () => new Response('gateway unavailable', { status: 502 })
  await assert.rejects(request('/fixture'), (error) => error.message === '请求失败（HTTP 502）' && !isAccountAuthenticationError(error))
})
