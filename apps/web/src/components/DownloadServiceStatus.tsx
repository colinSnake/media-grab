import { Server } from 'lucide-react'
import type { ExtractorStatus } from '../api'
import { ServiceStatusPopover } from './ServiceStatusPopover'

export function DownloadServiceStatus({ connection, extractor, retryCount }: {
  connection: 'connecting' | 'ready' | 'disconnected'
  extractor: ExtractorStatus | null
  retryCount: number
}) {
  const connected = connection === 'ready'
  const state = connection === 'disconnected' ? 'unavailable' : !connected || extractor === null ? 'checking' : extractor.available ? 'ready' : 'unavailable'
  const label = !connected ? connection === 'connecting' ? '连接中' : '未连接' : extractor === null ? '检查中' : extractor.available ? '已就绪' : '依赖不可用'
  const serviceLabel = connected ? '已连接' : retryCount > 0 ? `正在重连 · 第 ${retryCount} 次` : connection === 'disconnected' ? '未连接' : '正在启动'
  return <ServiceStatusPopover title="下载服务" state={state} label={label} icon={<Server aria-hidden="true" />} className="download-service">
    <dl className="service-status-details">
      <div><dt>服务</dt><dd>{serviceLabel}</dd></div>
      <div><dt>yt-dlp</dt><dd>{!connected ? '待连接' : extractor === null ? '检查中' : extractor.available ? extractor.version || '可用' : '不可用'}</dd></div>
    </dl>
    {connected && extractor && !extractor.available && <p className="service-status-reason" role="alert">{extractor.error || '未找到 yt-dlp，请在设置中检查可执行文件路径。'}</p>}
  </ServiceStatusPopover>
}
