import { ArrowDownToLine, Check, FileVideo2, Music2 } from 'lucide-react'
import { platformLabel, type MediaParseResult, type ParseResult, type QualityAvailability } from '@mediagrab/shared'

interface MediaPreviewProps {
  parsed: ParseResult | null
  genericParsed: MediaParseResult | null
  selectedQuality: number | null
  selectedStreamId: string | null
  onSelectQuality: (quality: number) => void
  onSelectStream: (streamId: string) => void
  onSelectPage: (page: number) => void
}

function formatDuration(seconds: number): string {
  if (seconds <= 0) return '--:--'
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  return `${minutes}:${rest.toString().padStart(2, '0')}`
}

function platformFromInput(input: string): string {
  const normalized = input.toLowerCase()
  if (normalized.includes('douyin') || normalized.includes('iesdouyin')) return '抖音'
  if (normalized.includes('xiaohongshu') || normalized.includes('xhslink')) return '小红书'
  return 'B站'
}

function qualityLabel(item: QualityAvailability): string {
  return item.label.replace('（', ' · ').replace('）', '')
}

function coverProxyUrl(cover: string): string {
  return `/api/cover?url=${encodeURIComponent(cover)}`
}

function MediaCover({ cover, durationSec }: { cover: string; durationSec: number }) {
  return (
    <div className="media-cover">
      {cover ? <><div className="cover-fallback"><FileVideo2 /></div><img src={coverProxyUrl(cover)} alt="" onError={(event) => event.currentTarget.remove()} /></> : <div className="cover-fallback"><FileVideo2 /></div>}
      <span className="cover-duration">{formatDuration(durationSec)}</span>
    </div>
  )
}

export function MediaPreview({ parsed, genericParsed, selectedQuality, selectedStreamId, onSelectQuality, onSelectStream, onSelectPage }: MediaPreviewProps) {
  const hasResult = parsed !== null || genericParsed !== null
  const platform = parsed !== null ? platformFromInput(parsed.input) : genericParsed?.platform

  return (
    <section className="panel result-panel">
      <div className="panel-heading">
        <div className="heading-title"><span className="heading-icon"><FileVideo2 /></span><div><h2>媒体预览</h2></div></div>
        {hasResult && <span className="recognized-pill"><span className="status-dot" />{platform}</span>}
      </div>
      {!hasResult ? (
        <div className="result-empty">
          <div className="empty-graphic"><div className="empty-play"><ArrowDownToLine /></div><span className="empty-spark spark-a" /><span className="empty-spark spark-b" /></div>
          <strong>等待一个链接</strong>
          <p>支持 B站、抖音与小红书分享链接</p>
        </div>
      ) : parsed !== null ? (
        <div className="media-result">
          <MediaCover cover={parsed.cover} durationSec={parsed.durationSec} />
          <div className="media-details">
            <div className="media-meta"><span className="mini-platform">{platformFromInput(parsed.input)}</span><span className="media-id">{parsed.bvid}</span></div>
            <h3 title={parsed.title}>{parsed.title}</h3>
            <div className="creator-row">
              <p className="creator">{parsed.ownerName || '未知创作者'} <span>·</span> {parsed.pages.length} 个分段</p>
              {parsed.pages.length > 1 && <label className="page-picker">
                <span>分 P</span>
                <select value={parsed.page} onChange={(event) => onSelectPage(Number(event.target.value))}>
                  {parsed.pages.map((page) => <option key={page.page} value={page.page}>{`P${page.page}${page.part ? ` · ${page.part}` : ''}`}</option>)}
                </select>
              </label>}
            </div>
            <div className="quality-list">
              <div className="resource-label">清晰度与访问限制 <span>以当前身份实际返回为准</span></div>
              <div className="quality-options">
                {parsed.qualities.slice(0, 8).map((item) => <button key={item.qn} type="button" disabled={!item.available} title={item.available ? '可下载' : item.reason} className={`quality-option ${item.qn === selectedQuality ? 'selected' : ''} ${item.available ? '' : 'unavailable'}`} onClick={() => onSelectQuality(item.qn)}>{qualityLabel(item)}{!item.available && <small>{item.reason}</small>}</button>)}
              </div>
            </div>
          </div>
        </div>
      ) : genericParsed !== null ? (
        <div className="media-result">
          <MediaCover cover={genericParsed.cover ?? ''} durationSec={genericParsed.durationSec} />
          <div className="media-details">
            <div className="media-meta"><span className={`mini-platform ${genericParsed.platform}`}>{platformLabel[genericParsed.platform]}</span><span className="media-id">{genericParsed.id}</span></div>
            <h3 title={genericParsed.title}>{genericParsed.title || '未命名媒体'}</h3>
            <p className="creator">{genericParsed.authorName || '未知创作者'} <span>·</span> {genericParsed.streams.length} 种资源</p>
            <div className="quality-list">
              <div className="resource-label">资源格式 <span>选择一个</span></div>
              <div className="stream-options">
                {genericParsed.streams.slice(0, 3).map((stream) => <button key={stream.id} type="button" className={`stream-option ${selectedStreamId === stream.id ? 'selected' : ''}`} onClick={() => onSelectStream(stream.id)}><span className="stream-kind">{stream.kind === 'audio' ? <Music2 /> : <FileVideo2 />}</span><span className="stream-copy"><strong>{stream.kind === 'video' ? stream.label || '视频' : `音频 ${stream.label || ''}`}</strong><small>{stream.codecs || stream.mimeType || '媒体流'}</small></span>{selectedStreamId === stream.id && <Check className="stream-check" />}</button>)}
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  )
}
