import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

type ActiveTooltip = { anchor: HTMLElement; label: string }

export function GlobalTooltip() {
  const [active, setActive] = useState<ActiveTooltip | null>(null)
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null)
  const activeRef = useRef(active)
  activeRef.current = active

  useLayoutEffect(() => {
    if (active === null) {
      setPosition(null)
      return
    }
    const update = () => {
      const tooltip = document.querySelector<HTMLElement>('.global-tooltip')
      const rect = active.anchor.getBoundingClientRect()
      if (tooltip === null) return
      const bounds = tooltip.getBoundingClientRect()
      const margin = 8
      const left = Math.max(margin, Math.min(rect.left + rect.width / 2 - bounds.width / 2, window.innerWidth - bounds.width - margin))
      const top = rect.top >= bounds.height + margin
        ? rect.top - bounds.height - margin
        : Math.min(rect.bottom + margin, window.innerHeight - bounds.height - margin)
      setPosition({ top: Math.max(margin, top), left })
    }
    update()
    window.addEventListener('scroll', update, true)
    window.addEventListener('resize', update)
    return () => {
      window.removeEventListener('scroll', update, true)
      window.removeEventListener('resize', update)
    }
  }, [active])

  useEffect(() => {
    const findTarget = (target: EventTarget | null) => target instanceof Element
      ? target.closest<HTMLElement>('[data-tooltip]')
      : null
    const show = (target: HTMLElement | null) => {
      const label = target?.getAttribute('data-tooltip')?.trim()
      setActive((current) => current?.anchor === target && current.label === label
        ? current
        : target && label ? { anchor: target, label } : null)
    }
    const onPointerOver = (event: PointerEvent) => show(findTarget(event.target))
    const onPointerOut = (event: PointerEvent) => {
      const anchor = findTarget(event.target)
      if (anchor && event.relatedTarget instanceof Node && anchor.contains(event.relatedTarget)) return
      if (anchor) setActive((current) => current?.anchor === anchor ? null : current)
    }
    const onFocusIn = (event: FocusEvent) => show(findTarget(event.target))
    const onFocusOut = (event: FocusEvent) => {
      const anchor = findTarget(event.target)
      if (anchor && event.relatedTarget instanceof Node && anchor.contains(event.relatedTarget)) return
      if (anchor) setActive((current) => current?.anchor === anchor ? null : current)
    }
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        const current = activeRef.current
        if (record.target === current?.anchor) {
          const label = current.anchor.getAttribute('data-tooltip')?.trim()
          setActive(label ? { anchor: current.anchor, label } : null)
        }
      }
    })
    observer.observe(document.documentElement, { subtree: true, attributes: true, attributeFilter: ['data-tooltip'] })
    document.addEventListener('pointerover', onPointerOver)
    document.addEventListener('pointerout', onPointerOut)
    document.addEventListener('focusin', onFocusIn)
    document.addEventListener('focusout', onFocusOut)
    return () => {
      observer.disconnect()
      document.removeEventListener('pointerover', onPointerOver)
      document.removeEventListener('pointerout', onPointerOut)
      document.removeEventListener('focusin', onFocusIn)
      document.removeEventListener('focusout', onFocusOut)
    }
  }, [])

  if (active === null) return null
  return createPortal(
    <span className="task-icon-tooltip global-tooltip" role="tooltip" style={{ top: position?.top ?? 0, left: position?.left ?? 0, visibility: position ? 'visible' : 'hidden' }}>{active.label}</span>,
    document.body,
  )
}
