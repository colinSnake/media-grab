import { invoke } from '@tauri-apps/api/core'

export function isDesktop(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

/** Only a native picker can supply a filesystem path; the Web UI has no direct FS access. */
export async function chooseDownloadDirectory(): Promise<string | null> {
  if (!isDesktop()) return null
  return invoke<string | null>('choose_download_dir')
}

export async function notifyDownloadFinished(title: string): Promise<void> {
  if (!isDesktop()) return
  await invoke('notify_download', { title })
}

/** Open a file that the local core has already written to the configured folder. */
export async function openDownloadFile(directory: string, fileName: string): Promise<void> {
  if (!isDesktop()) return
  await invoke('open_download_file', { directory, fileName })
}
