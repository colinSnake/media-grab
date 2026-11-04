import { useEffect, useRef, useState, type ReactNode } from 'react'
import { FileVideo2 } from 'lucide-react'
import { fetchWithCoreAuth } from '../api'

export function UpscaleTaskCover({ taskId, children }: { taskId: string; children: ReactNode }) {
  const element = useRef<HTMLDivElement>(null)
  const [visible, setVisible] = useState(false)
  const [source, setSource] = useState('')
  useEffect(() => {
    if (!element.current) return
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) { setVisible(true); observer.disconnect() }
    }, { rootMargin: '120px' })
    observer.observe(element.current)
    return () => observer.disconnect()
  }, [])
  useEffect(() => {
    if (!visible) return
    let disposed = false, url = ''
    const controller = new AbortController()
    setSource('')
    void fetchWithCoreAuth(`/api/upscale/tasks/${encodeURIComponent(taskId)}/thumbnail`, controller.signal).then(async (response) => {
      if (!response.ok || !response.headers.get('Content-Type')?.startsWith('image/png')) return
      const image = await response.blob()
      if (disposed || image.size > 512 * 1024) return
      url = URL.createObjectURL(image)
      setSource(url)
    }).catch(() => { /* A missing/moved source must not break task actions. */ })
    return () => { disposed = true; controller.abort(); if (url) URL.revokeObjectURL(url) }
  }, [taskId, visible])
  return <div ref={element} className="upscale-job-cover">
    <FileVideo2 className="upscale-cover-fallback" aria-hidden="true" />
    {source && <img src={source} alt="源视频首帧" onError={() => setSource('')} />}
    {children}
  </div>
}
