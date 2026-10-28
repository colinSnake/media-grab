import { ArrowDownToLine, Check, FileVideo2, Image as ImageIcon, Maximize2, Music2, Play, X } from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { platformLabel, type PublicMediaParseResult, type ParseResult, type Platform, type QualityAvailability } from '@mediagrab/shared'
import { apiUrl } from '../api'
import { PlatformLogo } from './PlatformLogo'

interface MediaPreviewProps {
  parsed: ParseResult | null
  genericParsed: PublicMediaParseResult | null
  selectedQuality: number | null
  selectedStreamId: string | null
  isParsing: boolean
  onSelectQuality: (quality: number) => void
  onSelectStream: (streamId: string) => void
  onSelectPage: (page: number) => void
}

function formatDuration(seconds: number): string {
  const safeSeconds = Math.max(0, Math.floor(seconds))
  const hours = Math.floor(safeSeconds / 3600)
  const minutes = Math.floor((safeSeconds % 3600) / 60)
  const rest = safeSeconds % 60
  return [hours, minutes, rest].map((value) => value.toString().padStart(2, '0')).join(':')
}

function qualityLabel(item: QualityAvailability): string {
  return item.label.replace('（', ' · ').replace('）', '')
}

function coverProxyUrl(cover: string): string {
  return apiUrl(cover.startsWith('/api/cover?ref=') ? cover : `/api/cover?url=${encodeURIComponent(cover)}`)
}

function MediaField({ label, children, wide = false }: { label: string; children: ReactNode; wide?: boolean }) {
  return <div className={`media-field ${wide ? 'wide' : ''}`}><span className="media-field-label">{label}</span><div className="media-field-value">{children}</div></div>
}

function MediaCover({ cover, durationSec, platform }: { cover: string; durationSec: number; platform: Platform }) {
  const [imageFailed, setImageFailed] = useState(false)
  const [previewOpen, setPreviewOpen] = useState(false)
  const previewButtonRef = useRef<HTMLButtonElement>(null)
  const dialogRef = useRef<HTMLElement>(null)
  const closeButtonRef = useRef<HTMLButtonElement>(null)
  const hasCover = cover !== '' && !imageFailed

  useEffect(() => {
    setImageFailed(false)
    setPreviewOpen(false)
  }, [cover])

  useEffect(() => {
    if (!previewOpen) return
    const previousOverflow = document.body.style.overflow
    const focusFrame = requestAnimationFrame(() => dialogRef.current?.focus())
    document.body.style.overflow = 'hidden'
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        setPreviewOpen(false)
      } else if (event.key === 'Tab') {
        event.preventDefault()
        closeButtonRef.current?.focus()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => {
      cancelAnimationFrame(focusFrame)
      window.removeEventListener('keydown', handleKeyDown)
      document.body.style.overflow = previousOverflow
      previewButtonRef.current?.focus()
    }
  }, [previewOpen])

  return (
    <div className={`media-cover ${hasCover ? '' : 'media-cover-empty'}`}>
      <div className="cover-fallback"><FileVideo2 /></div>
      {hasCover && <img className="cover-image" src={coverProxyUrl(cover)} alt="媒体封面" onError={() => setImageFailed(true)} />}
      <span className={`cover-platform ${platform}`} title={platformLabel[platform]}>{platform === 'unknown' ? <FileVideo2 className="platform-mark unknown-mark" aria-hidden="true" /> : <PlatformLogo platform={platform} className="platform-mark" />}</span>
      {durationSec > 0 && <span className="cover-duration">{formatDuration(durationSec)}</span>}
      {hasCover && <button ref={previewButtonRef} className="cover-preview-trigger" type="button" aria-label="放大查看封面" title="放大查看封面" onClick={() => setPreviewOpen(true)}><Maximize2 aria-hidden="true" /></button>}
      {previewOpen && hasCover && createPortal(
        <div className="cover-preview-backdrop" role="presentation" onClick={() => setPreviewOpen(false)}>
          <section ref={dialogRef} className="cover-preview-dialog" role="dialog" aria-modal="true" aria-label="封面预览" tabIndex={-1} onClick={(event) => event.stopPropagation()}>
            <img src={coverProxyUrl(cover)} alt="封面大图" />
            <button ref={closeButtonRef} className="cover-preview-close" type="button" aria-label="关闭预览" title="关闭预览" onClick={() => setPreviewOpen(false)}><X aria-hidden="true" /></button>
          </section>
        </div>,
        document.body,
      )}
    </div>
  )
}

export function MediaPreview({ parsed, genericParsed, selectedQuality, selectedStreamId, isParsing, onSelectQuality, onSelectStream, onSelectPage }: MediaPreviewProps) {
  const selectedStream = genericParsed?.streams.find((stream) => stream.id === selectedStreamId)

  return (
    <section className={`panel result-panel ${parsed !== null || genericParsed !== null ? 'has-media' : ''}`}>
      {(parsed !== null || genericParsed !== null) && <svg className="preview-ambient" viewBox="0 0 240 200" fill="none" aria-hidden="true" focusable="false">
        <circle cx="126" cy="98" r="82" strokeDasharray="2 8" />
        <circle cx="126" cy="98" r="66" />
        <g transform="rotate(-12 120 95)">
          <rect x="45" y="41" width="138" height="92" rx="12" />
          <path d="M45 61h138M65 41v20m22-20v20m22-20v20m22-20v20m22-20v20m22-20v20" />
        </g>
        <g transform="rotate(8 136 113)">
          <rect className="preview-ambient-card" x="70" y="69" width="134" height="87" rx="12" />
          <path d="m123 91 27 19-27 19Z" strokeLinejoin="round" />
        </g>
        <path d="M47 164h27l5-8 7 17 8-25 8 28 7-13h29m14 0h23m10 0h8" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M199 34v12m-6-6h12M35 111v8m-4-4h8" strokeLinecap="round" />
      </svg>}
      {(parsed !== null || genericParsed !== null) && <svg className="preview-footer-ambient" viewBox="0 0 440 64" fill="none" aria-hidden="true" focusable="false">
        <circle cx="32" cy="32" r="24" />
        <circle cx="32" cy="32" r="15" strokeDasharray="2 5" />
        <path d="m28 25 11 7-11 7Z" strokeLinejoin="round" />
        <path d="M78 40h58l6-7 7 14 9-25 10 31 8-21 7 8h103" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M302 40h44m8 0h10m8 0h60" strokeLinecap="round" strokeDasharray="3 6" />
        <circle cx="286" cy="40" r="3" />
        <path d="M104 22v7m-3.5-3.5h7M390 14v7m-3.5-3.5h7" strokeLinecap="round" />
      </svg>}
      <div className="panel-heading">
        <div className="heading-title"><div><h2>媒体预览</h2></div></div>
      </div>
      {parsed === null && genericParsed === null ? (
        <div className="result-empty">
          <div className="empty-graphic"><div className="empty-play"><ArrowDownToLine /></div><span className="empty-spark spark-a" /><span className="empty-spark spark-b" /></div>
          <strong>等待一个链接</strong>
          <p>粘贴链接后，媒体信息将在这里显示</p>
        </div>
      ) : parsed !== null ? (
        <div className="media-result">
          <MediaCover cover={parsed.cover} durationSec={parsed.durationSec} platform="bilibili" />
          <div className="media-details">
            <div className="media-overview">
              <div className="resource-label">媒体信息</div>
              <div className="media-fields">
                <MediaField label="标题" wide><h3 title={parsed.title}>{parsed.title}</h3></MediaField>
                <MediaField label="编号"><span className="media-id">{parsed.bvid}</span></MediaField>
                <MediaField label="作者"><p className="creator" title={parsed.ownerName || '未知创作者'}>{parsed.ownerName || '未知创作者'}</p></MediaField>
                <MediaField label="分段"><div className="media-field-inline"><span className="creator">{parsed.pages.length} 个</span>{parsed.pages.length > 1 && <label className="page-picker">
                  <span>选择</span>
                  <select value={parsed.page} onChange={(event) => onSelectPage(Number(event.target.value))} disabled={isParsing}>
                    {parsed.pages.map((page) => <option key={page.page} value={page.page}>{`P${page.page}${page.part ? ` · ${page.part}` : ''}`}</option>)}
                  </select>
                </label>}</div></MediaField>
              </div>
            </div>
            <div className="quality-list resolution-list">
              <div className="resource-label"><strong>视频清晰度</strong><span>{parsed.qualities.length} 个档位</span></div>
              <div className="quality-options">
                {parsed.qualities.map((item) => <button key={item.qn} type="button" aria-pressed={item.qn === selectedQuality} disabled={!item.available} title={`${qualityLabel(item)}${item.available ? '' : ` · ${item.reason}`}`} className={`quality-option ${item.qn === selectedQuality ? 'selected' : ''} ${item.available ? '' : 'unavailable'}`} onClick={() => onSelectQuality(item.qn)}><span className="quality-option-heading"><span>{qualityLabel(item)}</span>{item.qn === selectedQuality && <Check aria-hidden="true" />}</span>{!item.available && <small>{item.reason}</small>}</button>)}
              </div>
            </div>
          </div>
        </div>
      ) : genericParsed !== null ? (
        <div className="media-result">
          <MediaCover cover={selectedStream?.kind === 'image' ? selectedStream.preview ?? genericParsed.cover : genericParsed.cover} durationSec={genericParsed.durationSec} platform={genericParsed.platform} />
          <div className="media-details">
            <div className="media-overview">
              <div className="resource-label">媒体信息</div>
              <div className="media-fields">
                <MediaField label="标题" wide><h3 title={genericParsed.title}>{genericParsed.title || '未命名媒体'}</h3></MediaField>
                <MediaField label="编号"><span className="media-id">{genericParsed.id}</span></MediaField>
                <MediaField label="作者"><p className="creator" title={genericParsed.authorName || '未知创作者'}>{genericParsed.authorName || '未知创作者'}</p></MediaField>
                <MediaField label="资源"><span className="creator">{genericParsed.streams.length} 种</span></MediaField>
              </div>
            </div>
            <div className="quality-list">
              <div className="resource-label">资源格式 <span>选择一个</span></div>
              <div className="stream-options">
                {[...genericParsed.streams].sort((left, right) => Number(right.available) - Number(left.available)).map((stream) => {
                  const label = stream.kind === 'audio' ? `音频 ${stream.label || ''}`.trim() : stream.kind === 'image' ? stream.label || '图片' : stream.label || '视频'
                  const detail = stream.available ? stream.codecs || stream.mimeType || '媒体流' : stream.reason || '暂不可用'
                  return <button key={stream.id} type="button" disabled={!stream.available} aria-pressed={selectedStreamId === stream.id} title={`${label} · ${detail}`} className={`stream-option ${selectedStreamId === stream.id ? 'selected' : ''} ${stream.available ? '' : 'unavailable'}`} onClick={() => onSelectStream(stream.id)}>
                    <span className="stream-kind" aria-hidden="true">{stream.kind === 'audio' ? <Music2 /> : stream.kind === 'image' ? <ImageIcon /> : <Play fill="currentColor" strokeWidth={1.5} />}</span>
                    <span className="stream-copy"><strong>{label}</strong><small>{detail}</small></span>
                    <span className="stream-check" aria-hidden="true">{selectedStreamId === stream.id && <Check />}</span>
                  </button>
                })}
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  )
}
