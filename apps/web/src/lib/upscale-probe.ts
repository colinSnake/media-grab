import type { UpscaleMedia } from '@mediagrab/shared'
import type { UpscaleSelection } from '../native'

export interface UpscalePreview { grant: string; media: UpscaleMedia }
type Selection = { input: UpscaleSelection; directory: UpscaleSelection }
const selectionKey = ({ input, directory }: Selection) => JSON.stringify([input.path, input.proof, directory.path, directory.proof])

/** Share in-flight checks and renew before the core's ten-minute grant expiry. */
export class UpscaleProbeLoader {
  private revision = 0
  private cached?: { key: string; value: UpscalePreview; checkedAt: number }
  private pending?: { key: string; revision: number; promise: Promise<UpscalePreview> }
  constructor(private load: (selection: Selection) => Promise<UpscalePreview>, private now = Date.now) {}
  peek(selection: Selection): UpscalePreview | undefined {
    if (!this.cached || this.cached.key !== selectionKey(selection)) return
    const age = this.now() - this.cached.checkedAt
    if (age >= 0 && age < 9 * 60_000) return this.cached.value
  }
  invalidate(): void { this.cached = undefined; this.revision++ }
  prepare(selection: Selection): Promise<UpscalePreview> {
    const cached = this.peek(selection)
    if (cached) return Promise.resolve(cached)
    const key = selectionKey(selection), revision = this.revision
    if (this.pending?.key === key && this.pending.revision === revision) return this.pending.promise
    // The core permits only one media check at a time. Let obsolete checks settle
    // before a new selection starts; a failed old check must not block the next one.
    const previous = this.pending?.promise.catch(() => {}) ?? Promise.resolve()
    const promise = previous.then(() => this.load(selection)).then((value) => {
      if (revision === this.revision) this.cached = { key, value, checkedAt: this.now() }
      return value
    }).finally(() => { if (this.pending?.promise === promise) this.pending = undefined })
    this.pending = { key, revision, promise }
    return promise
  }
}
