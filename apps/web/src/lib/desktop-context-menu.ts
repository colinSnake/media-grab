/** Suppress WebView's Reload / Inspect menu in desktop dev and packaged windows.
 * Do not stop propagation: app-owned menus can still handle the same event.
 * Keyboard shortcuts and explicit copy controls are unaffected.
 */
export function installDesktopContextMenuGuard(target: EventTarget): () => void {
  if (!('__TAURI_INTERNALS__' in target)) return () => {}
  const preventNativeMenu = (event: Event): void => event.preventDefault()
  target.addEventListener('contextmenu', preventNativeMenu, { capture: true })
  return () => target.removeEventListener('contextmenu', preventNativeMenu, { capture: true })
}
