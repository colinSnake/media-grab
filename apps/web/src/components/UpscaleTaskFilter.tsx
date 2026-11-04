import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { AlertTriangle, Check, ChevronDown, Clock3, ListFilter, LoaderCircle, Square } from 'lucide-react'
import type { UpscaleTask } from '@mediagrab/shared'

export type UpscaleTaskFilterValue = 'all' | UpscaleTask['status']
const options = [
  { value: 'all', label: '全部任务', icon: ListFilter },
  { value: 'running', label: '处理中', icon: LoaderCircle },
  { value: 'queued', label: '排队中', icon: Clock3 },
  { value: 'succeeded', label: '已完成', icon: Check },
  { value: 'failed', label: '处理失败', icon: AlertTriangle },
  { value: 'cancelled', label: '已取消', icon: Square },
  { value: 'interrupted', label: '已中断', icon: AlertTriangle },
] as const

export function UpscaleTaskFilter({ value, onChange }: { value: UpscaleTaskFilterValue; onChange: (value: UpscaleTaskFilterValue) => void }) {
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState<{ top: number; left: number; maxHeight: number } | null>(null)
  const trigger = useRef<HTMLButtonElement>(null), menu = useRef<HTMLDivElement>(null)
  const id = useId()
  const selected = options.find((option) => option.value === value) ?? options[0]
  const Icon = selected.icon
  const close = () => { setOpen(false); trigger.current?.focus({ preventScroll: true }) }
  useLayoutEffect(() => {
    if (!open) { setPosition(null); return }
    const update = () => {
      const anchor = trigger.current?.getBoundingClientRect()
      if (!anchor) return
      const below = window.innerHeight - anchor.bottom - 18, above = anchor.top - 18
      const maxHeight = Math.min(232, window.innerHeight - 24, Math.max(60, below, above))
      setPosition({ top: below >= maxHeight ? anchor.bottom + 6 : Math.max(12, anchor.top - maxHeight - 6), left: Math.max(12, Math.min(anchor.right - 170, window.innerWidth - 182)), maxHeight })
    }
    update()
    window.addEventListener('resize', update); window.addEventListener('scroll', update, true)
    return () => { window.removeEventListener('resize', update); window.removeEventListener('scroll', update, true) }
  }, [open])
  const positioned = position !== null
  useEffect(() => {
    if (open && positioned) menu.current?.querySelector<HTMLButtonElement>('[aria-selected="true"]')?.focus({ preventScroll: true })
  }, [open, positioned])
  useEffect(() => {
    if (!open) return
    const outside = (event: Event) => {
      if (event.target instanceof Node && !trigger.current?.contains(event.target) && !menu.current?.contains(event.target)) setOpen(false)
    }
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') close() }
    document.addEventListener('pointerdown', outside); document.addEventListener('focusin', outside); document.addEventListener('keydown', escape)
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('focusin', outside); document.removeEventListener('keydown', escape) }
  }, [open])
  return <div className="platform-filter" data-open={open}>
    <button ref={trigger} className="platform-filter-trigger" type="button" aria-label={`超分任务筛选：${selected.label}`} aria-haspopup="listbox" aria-expanded={open} aria-controls={open ? id : undefined} onClick={() => setOpen(!open)} onKeyDown={(event) => { if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setOpen(true) } }}>
      <span className="platform-filter-icon upscale-filter-icon"><Icon aria-hidden="true" /></span><span>{selected.label}</span><ChevronDown className="platform-filter-chevron" aria-hidden="true" />
    </button>
    {open && createPortal(<div ref={menu} id={id} className="platform-filter-menu upscale-filter-menu" role="listbox" aria-label="超分任务状态筛选" style={{ top: position?.top ?? 0, left: position?.left ?? 0, maxHeight: position?.maxHeight, visibility: position ? 'visible' : 'hidden' }} onKeyDown={(event) => {
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
      event.preventDefault()
      const buttons = [...(menu.current?.querySelectorAll<HTMLButtonElement>('[role="option"]') ?? [])]
      const current = buttons.indexOf(document.activeElement as HTMLButtonElement)
      const index = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (current + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length
      buttons[index]?.focus()
    }}>{options.map((option) => <button key={option.value} type="button" role="option" aria-selected={value === option.value} className={value === option.value ? 'selected' : ''} onClick={() => { onChange(option.value); close() }}><span className="platform-filter-icon upscale-filter-icon"><option.icon aria-hidden="true" /></span><span>{option.label}</span>{value === option.value && <Check aria-hidden="true" />}</button>)}</div>, document.body)}
  </div>
}
