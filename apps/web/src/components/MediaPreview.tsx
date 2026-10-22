import { ArrowDownToLine, Check, FileVideo2, Music2, Pause, Play } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { platformLabel, type MediaParseResult, type ParseResult, type Platform, type QualityAvailability } from '@mediagrab/shared'
import { PlatformLogo } from './PlatformLogo'

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
  return `/api/cover?url=${encodeURIComponent(cover)}`
}

function MediaCover({ cover, durationSec, videoUrl, platform }: { cover: string; durationSec: number; videoUrl?: string; platform: Platform }) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const [isPlaying, setIsPlaying] = useState(false)

  useEffect(() => {
    setIsPlaying(false)
    if (videoRef.current !== null) videoRef.current.pause()
  }, [videoUrl])

  useEffect(() => {
    if (videoUrl === undefined) return
    function handleKeyDown(event: KeyboardEvent) {
      const target = event.target
      if (event.code !== 'Space' || target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT|BUTTON)$/.test(target.tagName))) return
      event.preventDefault()
      const video = videoRef.current
      if (video === null) return
      if (video.paused) void video.play().catch(() => setIsPlaying(false))
      else video.pause()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [videoUrl])

  function togglePlayback() {
    const video = videoRef.current
    if (video === null) return
    if (video.paused) void video.play().catch(() => setIsPlaying(false))
    else video.pause()
  }

  return (
    <div className={`media-cover ${videoUrl !== undefined ? 'playable' : ''} ${isPlaying ? 'is-playing' : ''}`}>
      {cover ? <><div className="cover-fallback"><FileVideo2 /></div><img className="cover-image" src={coverProxyUrl(cover)} alt="" onError={(event) => event.currentTarget.remove()} />{
        videoUrl !== undefined && <video ref={videoRef} src={videoUrl} poster={coverProxyUrl(cover)} preload="none" playsInline onPlay={() => setIsPlaying(true)} onPause={() => setIsPlaying(false)} onEnded={() => setIsPlaying(false)} />
      }</> : <div className="cover-fallback"><FileVideo2 /></div>}
      <span className={`cover-platform ${platform}`} title={platformLabel[platform]}>{platform === 'unknown' ? <FileVideo2 className="platform-mark unknown-mark" aria-hidden="true" /> : <PlatformLogo platform={platform} className="platform-mark" />}</span>
      {videoUrl !== undefined && <button type="button" className="cover-play" onClick={togglePlayback} aria-label={isPlaying ? '暂停预览' : '播放预览'} title={`${isPlaying ? '暂停' : '播放'}预览（空格）`}>{isPlaying ? <Pause fill="currentColor" /> : <Play fill="currentColor" />}</button>}
      <span className="cover-duration">{formatDuration(durationSec)}</span>
    </div>
  )
}

export function MediaPreview({ parsed, genericParsed, selectedQuality, selectedStreamId, onSelectQuality, onSelectStream, onSelectPage }: MediaPreviewProps) {
  const selectedStream = genericParsed?.streams.find((stream) => stream.id === selectedStreamId)
  const previewUrl = selectedStream?.kind === 'video' && selectedStream.available ? selectedStream.url : undefined

  return (
    <section className="panel result-panel">
      <div className="panel-heading">
        <div className="heading-title"><span className="heading-icon"><FileVideo2 /></span><div><h2>媒体预览</h2></div></div>
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
              <div className="media-meta"><span className="media-id">{parsed.bvid}</span></div>
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
          <MediaCover cover={genericParsed.cover ?? ''} durationSec={genericParsed.durationSec} videoUrl={previewUrl} platform={genericParsed.platform} />
          <div className="media-details">
            <div className="media-overview">
              <div className="media-meta"><span className="media-id">{genericParsed.id}</span></div>
              <h3 title={genericParsed.title}>{genericParsed.title || '未命名媒体'}</h3>
              <p className="creator">{genericParsed.authorName || '未知创作者'} <span>·</span> {genericParsed.streams.length} 种资源</p>
            </div>
            <div className="quality-list">
              <div className="resource-label">资源格式 <span>选择一个</span></div>
              <div className="stream-options">
                {[...genericParsed.streams].sort((left, right) => Number(right.available) - Number(left.available)).slice(0, 3).map((stream) => <button key={stream.id} type="button" disabled={!stream.available} title={stream.available ? undefined : stream.reason || '当前资源不可用'} className={`stream-option ${selectedStreamId === stream.id ? 'selected' : ''} ${stream.available ? '' : 'unavailable'}`} onClick={() => onSelectStream(stream.id)}><span className="stream-kind">{stream.kind === 'audio' ? <Music2 /> : <FileVideo2 />}</span><span className="stream-copy"><strong>{stream.kind === 'video' ? stream.label || '视频' : `音频 ${stream.label || ''}`}</strong><small>{stream.available ? stream.codecs || stream.mimeType || '媒体流' : stream.reason || '暂不可用'}</small></span>{selectedStreamId === stream.id && <Check className="stream-check" />}</button>)}
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  )
}
