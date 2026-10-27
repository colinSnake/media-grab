import { useEffect, useLayoutEffect, useRef, useState, type ComponentProps, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

export function TaskIconTooltip({ label, children }: { label: string; children: ReactNode }) {
  const anchorRef = useRef<HTMLSpanElement>(null)
  const tooltipRef = useRef<HTMLSpanElement>(null)
  const hideTimer = useRef<number | null>(null)
  const [hovered, setHovered] = useState(false)
  const [focused, setFocused] = useState(false)
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null)
  const visible = hovered || focused

  const clearHide = () => {
    if (hideTimer.current !== null) window.clearTimeout(hideTimer.current)
    hideTimer.current = null
  }

  useEffect(() => () => clearHide(), [])

  useLayoutEffect(() => {
    if (!visible) return
    const update = () => {
      const anchor = anchorRef.current?.getBoundingClientRect()
      const tooltip = tooltipRef.current?.getBoundingClientRect()
      if (!anchor || !tooltip) return
      const margin = 8
      const left = Math.max(margin, Math.min(anchor.left + anchor.width / 2 - tooltip.width / 2, window.innerWidth - tooltip.width - margin))
      let top = anchor.top - tooltip.height - margin
      if (top < margin) top = anchor.bottom + margin
      top = Math.max(margin, Math.min(top, window.innerHeight - tooltip.height - margin))
      setPosition((current) => current?.top === top && current.left === left ? current : { top, left })
    }
    update()
    window.addEventListener('scroll', update, true)
    window.addEventListener('resize', update)
    return () => {
      window.removeEventListener('scroll', update, true)
      window.removeEventListener('resize', update)
    }
  }, [visible, label])

  return <>
    <span
      ref={anchorRef}
      className="task-icon-anchor"
      onMouseEnter={() => { clearHide(); setHovered(true) }}
      onMouseLeave={() => { clearHide(); hideTimer.current = window.setTimeout(() => setHovered(false), 120) }}
      onFocusCapture={() => setFocused(true)}
      onBlurCapture={(event) => { if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setFocused(false) }}
    >{children}</span>
    {visible && createPortal(
      <span ref={tooltipRef} className="task-icon-tooltip" role="tooltip" style={{ top: position?.top ?? 0, left: position?.left ?? 0, visibility: position ? 'visible' : 'hidden' }} onMouseEnter={() => { clearHide(); setHovered(true) }} onMouseLeave={() => { clearHide(); setHovered(false) }}>{label}</span>,
      document.body,
    )}
  </>
}

export function TaskIconButton({ label, children, ...props }: Omit<ComponentProps<'button'>, 'title' | 'aria-label'> & { label: string }) {
  return <TaskIconTooltip label={label}><button {...props} aria-label={label}>{children}</button></TaskIconTooltip>
}
