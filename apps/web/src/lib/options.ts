import type { DownloadMode } from '@mediagrab/shared'

export const modeOptions: { value: DownloadMode; label: string; detail: string }[] = [
  { value: 'video+audio', label: '视频 + 音频', detail: 'MP4 合并' },
  { value: 'video', label: '仅视频', detail: '不含音频' },
  { value: 'audio', label: '仅音频', detail: '' },
]
