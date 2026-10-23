import { ApiError } from '../lib/errors.js'

/** Per-adapter, bounded queue: at most one extractor process at a time. */
export class ExtractorGate {
  #tail: Promise<void> = Promise.resolve()
  #pending = 0
  #lastStartedAt = 0

  constructor(readonly intervalMs: number, readonly maxPending = 16) {}

  async run<T>(job: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) throw new ApiError('TASK_CANCELLED', '任务已取消', 'invalid', 400)
    if (this.#pending >= this.maxPending) {
      throw new ApiError('EXTRACTOR_BUSY', '平台解析请求较多，请稍后重试', 'risk', 429)
    }
    this.#pending++
    const predecessor = this.#tail
    let finish!: () => void
    const completed = new Promise<void>((resolve) => { finish = resolve })
    // A cancelled waiter must not let later jobs overtake the active process.
    this.#tail = predecessor.then(() => completed)
    try {
      await abortable(predecessor, signal)
      await abortableDelay(Math.max(0, this.#lastStartedAt + this.intervalMs - Date.now()), signal)
      this.#lastStartedAt = Date.now()
      return await job()
    } finally {
      this.#pending--
      finish()
    }
  }
}

function cancelled(): ApiError {
  return new ApiError('TASK_CANCELLED', '任务已取消', 'invalid', 400)
}

function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal === undefined) return promise
  if (signal.aborted) return Promise.reject(cancelled())
  return new Promise<T>((resolve, reject) => {
    const cleanup = () => signal.removeEventListener('abort', onAbort)
    const onAbort = () => { cleanup(); reject(cancelled()) }
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => { cleanup(); resolve(value) },
      (error: unknown) => { cleanup(); reject(error) },
    )
  })
}

function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return signal?.aborted ? Promise.reject(cancelled()) : Promise.resolve()
  if (signal?.aborted) return Promise.reject(cancelled())
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(cancelled())
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}
