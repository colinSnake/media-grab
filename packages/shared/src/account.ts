import { z } from 'zod'

export const accountPlatformSchema = z.enum(['bilibili', 'douyin', 'xiaohongshu'])
export type AccountPlatform = z.infer<typeof accountPlatformSchema>

export const accountStatusSchema = z.enum(['active', 'invalid', 'needs-login'])
export type AccountStatus = z.infer<typeof accountStatusSchema>

/** 前端可见的账号摘要；绝不包含 Cookie、令牌或其它凭据。 */
export const accountSummarySchema = z.object({
  id: z.string().min(1),
  platform: accountPlatformSchema,
  label: z.string().min(1),
  displayName: z.string().default(''),
  loggedIn: z.boolean(),
  vip: z.boolean(),
  status: accountStatusSchema,
  active: z.boolean(),
  lastVerifiedAt: z.number().int().nullable(),
})
export type AccountSummary = z.infer<typeof accountSummarySchema>

export const accountListResponseSchema = z.object({ accounts: z.array(accountSummarySchema) })
export type AccountListResponse = z.infer<typeof accountListResponseSchema>

export const biliAccountImportSchema = z.object({
  label: z.string().trim().min(1).max(80).default('B站账号'),
  /** 仅在本机核心内处理，响应永远不会回传该字段。 */
  cookie: z.string().trim().min(1).max(16_384),
})
export type BiliAccountImport = z.infer<typeof biliAccountImportSchema>

export const accountIdParamsSchema = z.object({ id: z.string().min(1) })
