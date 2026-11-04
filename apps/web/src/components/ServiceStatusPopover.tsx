import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import './service-status.css'

export type ServiceStatus = 'ready' | 'checking' | 'unavailable'

export function ServiceStatusPopover({ title, state, label, icon, className = '', action, children }: {
  title: string
  state: ServiceStatus
  label: string
  icon: ReactNode
  className?: string
  action?: ReactNode
  children: ReactNode
}) {
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null)
  const positioned = position !== null
  const trigger = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const id = useId()
  const close = () => { setOpen(false); trigger.current?.focus({ preventScroll: true }) }

  useLayoutEffect(() => {
    if (!open) { setPosition(null); return }
    const update = () => {
      const anchor = trigger.current?.getBoundingClientRect(), detail = panel.current?.getBoundingClientRect()
      if (!anchor || !detail) return
      const margin = 12
      const left = Math.max(margin, Math.min(anchor.right - detail.width, window.innerWidth - detail.width - margin))
      const top = Math.max(margin, Math.min(anchor.bottom + 8, window.innerHeight - detail.height - margin))
      setPosition((current) => current?.top === top && current.left === left ? current : { top, left })
    }
    update()
    // Status text and error messages may change the open panel's dimensions.
    const observer = new ResizeObserver(update)
    if (panel.current) observer.observe(panel.current)
    if (trigger.current) observer.observe(trigger.current)
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', update, true)
    }
  }, [open])
  useLayoutEffect(() => {
    if (open && positioned) panel.current?.focus({ preventScroll: true })
  }, [open, positioned])
  useEffect(() => {
    if (!open) return
    const outside = (event: Event) => {
      if (event.target instanceof Node && !trigger.current?.contains(event.target) && !panel.current?.contains(event.target)) setOpen(false)
    }
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { setOpen(false); trigger.current?.focus({ preventScroll: true }) }
    }
    document.addEventListener('pointerdown', outside)
    document.addEventListener('keydown', escape)
    document.addEventListener('focusin', outside)
    return () => {
      document.removeEventListener('pointerdown', outside)
      document.removeEventListener('keydown', escape)
      document.removeEventListener('focusin', outside)
    }
  }, [open])

  return <>
    <button ref={trigger} className={`icon-button service-status-trigger ${className ? `${className}-trigger` : ''} ${state}`} type="button" data-tooltip={`${title} · ${label}`} aria-expanded={open} aria-haspopup="dialog" aria-controls={open ? id : undefined} aria-label={`${title}：${label}，查看详情`} onClick={() => open ? close() : setOpen(true)}>
      {icon}<span className="service-status-dot" aria-hidden="true" />
    </button>
    {open && createPortal(<div ref={panel} id={id} className={`service-status-popover ${className ? `${className}-popover` : ''} ${state}`} role="dialog" aria-modal="false" aria-labelledby={`${id}-title`} tabIndex={-1} onPointerDown={(event) => event.stopPropagation()} style={{ top: position?.top ?? 0, left: position?.left ?? 0, visibility: position ? 'visible' : 'hidden' }}>
      <div className="service-status-heading"><span>{icon}<strong id={`${id}-title`}>{title}</strong></span><div className="service-status-heading-actions"><span className="service-status-label" role="status"><i aria-hidden="true" />{label}</span>{action}</div></div>
      {children}
    </div>, document.body)}
  </>
}
