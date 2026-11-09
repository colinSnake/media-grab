/** Tickets prevent cancelled/late responses from mutating a newer selection. */
export class RepairPreviewRequests {
  private revision = 0
  private controller?: AbortController
  cancel(): void { this.revision++; this.controller?.abort(); this.controller = undefined }
  start(): { signal: AbortSignal; current: () => boolean } {
    this.cancel()
    const revision = this.revision, controller = new AbortController()
    this.controller = controller
    return { signal: controller.signal, current: () => revision === this.revision && !controller.signal.aborted }
  }
}

export async function repairResponseError(response: Response): Promise<Error> {
  try {
    const body = await response.json() as { error?: { message?: unknown } }
    if (typeof body.error?.message === 'string') return new Error(body.error.message)
  } catch { /* A failed proxy may return HTML rather than JSON. */ }
  return new Error(`修补预览生成失败（HTTP ${response.status}），请重试`)
}
