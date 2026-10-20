import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './styles.css'

const themeStorageKey = 'mediagrab-theme'
let storedTheme: string | null = null
try {
  storedTheme = localStorage.getItem(themeStorageKey)
} catch {
  // The app can still follow the system when storage is unavailable.
}
const theme = storedTheme === 'light' || storedTheme === 'dark'
  ? storedTheme
  : window.matchMedia('(prefers-color-scheme: dark)').matches
    ? 'dark'
    : 'light'
document.documentElement.dataset.theme = theme
document.documentElement.style.colorScheme = theme

const desktopWindow = window as Window & { __TAURI_INTERNALS__?: unknown }
if (desktopWindow.__TAURI_INTERNALS__ !== undefined && navigator.platform.toLowerCase().includes('mac')) {
  document.documentElement.dataset.desktopWindow = 'macos'
}

const container = document.getElementById('root')
if (container === null) throw new Error('未找到 #root 挂载点')

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
