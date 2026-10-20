import { Clock3, FileVideo2, Music2, Search, X } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { platformLabel, type TaskSnapshot } from '@mediagrab/shared'
import { isTerminalTask } from './TaskRow'

interface TaskSearchDialogProps {
  open: boolean
  tasks: TaskSnapshot[]
  onClose: () => void
  onSelect: (task: TaskSnapshot) => void
}

export function TaskSearchDialog({ open, tasks, onClose, onSelect }: TaskSearchDialogProps) {
  const [query, setQuery] = useState('')

  useEffect(() => {
    if (!open) return
    setQuery('')
  }, [open])

  useEffect(() => {
    if (!open) return
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [open, onClose])

  const { results, resultCount } = useMemo(() => {
    const normalized = query.trim().toLowerCase()
    if (normalized === '') return { results: tasks.slice(0, 8), resultCount: tasks.length }
    const matches = tasks.filter((task) => [task.title, task.input, task.bvid, task.platform, platformLabel[task.platform], task.fileName, task.status]
      .some((value) => value.toLowerCase().includes(normalized)))
    return { results: matches.slice(0, 20), resultCount: matches.length }
  }, [query, tasks])

  if (!open) return null

  return (
    <div className="modal-backdrop search-backdrop" role="presentation" onClick={onClose}>
      <section className="search-modal" role="dialog" aria-modal="true" aria-labelledby="task-search-title" onClick={(event) => event.stopPropagation()}>
        <div className="modal-heading search-heading">
          <div><h2 id="task-search-title">搜索任务</h2></div>
          <button className="icon-button" type="button" title="关闭搜索" onClick={onClose}><X /></button>
        </div>
        <label className="search-input-wrap">
          <Search />
          <input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索标题、平台、状态或文件名" aria-label="搜索任务" />
        </label>
        <div className="search-result-meta">{query.trim() === '' ? '最近任务' : `找到 ${resultCount} 个结果`}</div>
        <div className="search-results">
          {results.length === 0 ? <div className="search-empty"><FileVideo2 /><strong>没有匹配的任务</strong><span>试试标题、平台或文件名中的关键词。</span></div> : results.map((task) => (
            <button className="search-result" type="button" key={task.id} onClick={() => onSelect(task)}>
              <span className={`task-type-icon ${task.mode === 'audio' ? 'audio' : ''}`}>{task.mode === 'audio' ? <Music2 /> : <FileVideo2 />}</span>
              <span className="task-title"><strong>{task.title || task.bvid || task.input}</strong><small>{platformLabel[task.platform]} · {isTerminalTask(task) ? '历史记录' : '下载队列'}</small></span>
              <Clock3 className="search-result-arrow" />
            </button>
          ))}
        </div>
      </section>
    </div>
  )
}
