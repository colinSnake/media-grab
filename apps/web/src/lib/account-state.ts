import type { AccountSummary, CookieStatus } from '@mediagrab/shared'

export type CookieAccountState = CookieStatus & { cookie: string; saving: boolean; authFailed: boolean }

/** A status refresh only replaces saved credentials; keep a newly pasted replacement. */
export function applyCookieStatus(current: CookieAccountState, status: CookieStatus): CookieAccountState {
  return { ...current, configured: status.configured, credentialPreview: status.configured ? status.credentialPreview : null }
}

export function invalidateAccount(account: AccountSummary): AccountSummary {
  return { ...account, status: 'needs-login', loggedIn: false, vip: false, credentialPreview: null }
}

export function accountCredentialPreview(account: AccountSummary | undefined): string | null {
  return account?.status === 'active' ? account.credentialPreview ?? null : null
}
