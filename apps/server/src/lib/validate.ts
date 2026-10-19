import { ZodError, z, type ZodTypeAny } from 'zod'
import { ApiError } from './errors.js'

/** 把 zod 校验错误整理成人能读的一行文案（NFR-07：错误信息要能指导用户改输入） */
export function describeValidationError(err: unknown): string {
  if (err instanceof ZodError) {
    return err.issues
      .map((issue) => {
        const where = issue.path.length > 0 ? issue.path.join('.') : '(root)'
        return `${where}: ${issue.message}`
      })
      .join('; ')
  }
  return err instanceof Error ? err.message : '请求参数校验失败'
}

/**
 * 请求体校验：失败一律 400 + 明确文案，不允许"静默用默认值"。
 *
 * 泛型取 `z.infer<S>`（输出类型）：`ZodType<T>` 在 zod v3 下会把 T 推成**输入**类型，
 * 带 `.default()` 的字段会变成可选，调用方就得为自己的 schema 写一堆 `?? ''`。
 */
export function parseBody<S extends ZodTypeAny>(schema: S, raw: unknown): z.infer<S> {
  const result = schema.safeParse(raw ?? {})
  if (!result.success) {
    throw new ApiError('INVALID_INPUT', describeValidationError(result.error), 'invalid', 400)
  }
  return result.data
}
