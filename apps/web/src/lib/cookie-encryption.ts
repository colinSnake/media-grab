import { credentialEncryptionHeader } from '@mediagrab/shared'

function base64url(bytes: Uint8Array): string {
  let binary = ''
  // Avoid spreading a long Cookie into a function's argument list.
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** Encrypt the pending draft for display; its temporary key is never exported. */
export async function encryptCookieForDisplay(cookie: string): Promise<string> {
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt'])
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const bytes = new Uint8Array(await crypto.subtle.encrypt({
    name: 'AES-GCM',
    iv,
    additionalData: new TextEncoder().encode(credentialEncryptionHeader),
    tagLength: 128,
  }, key, new TextEncoder().encode(cookie)))
  return [
    credentialEncryptionHeader,
    '',
    base64url(iv),
    base64url(bytes.subarray(0, -16)),
    base64url(bytes.subarray(-16)),
  ].join('.')
}
