import { z } from 'zod'

export const accountPlatformSchema = z.enum(['bilibili', 'douyin', 'xiaohongshu'])
export type AccountPlatform = z.infer<typeof accountPlatformSchema>

export const accountStatusSchema = z.enum(['active', 'invalid', 'needs-login'])
export type AccountStatus = z.infer<typeof accountStatusSchema>

/** JWE compact serialization: direct key management with AES-256-GCM. */
export const credentialEncryptionHeader = 'eyJhbGciOiJkaXIiLCJlbmMiOiJBMjU2R0NNIn0'

/** 完整加密 Cookie；不包含明文或解密密钥。 */
export const credentialPreviewSchema = z.string().regex(new RegExp(
  `^${credentialEncryptionHeader}\\.\\.[A-Za-z0-9_-]{16}\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]{22}$`,
)).nullable().optional()

/** 前端可见的账号摘要；仅可包含 Cookie 密文，绝不包含原文或解密密钥。 */
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
  credentialPreview: credentialPreviewSchema,
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

export const cookieAccountPlatformSchema = z.enum(['douyin', 'xiaohongshu', 'youtube'])
export type CookieAccountPlatform = z.infer<typeof cookieAccountPlatformSchema>

export const cookieAccountParamsSchema = z.object({ platform: cookieAccountPlatformSchema })

export const platformCookieSchema = z.object({
  cookie: z.string().trim().min(1).max(65_536),
})
export type PlatformCookieInput = z.infer<typeof platformCookieSchema>

export const cookieStatusSchema = z.object({ configured: z.boolean(), credentialPreview: credentialPreviewSchema })
export type CookieStatus = z.infer<typeof cookieStatusSchema>

export const douyinCookieSchema = platformCookieSchema
export const douyinCookieStatusSchema = cookieStatusSchema
export const xiaohongshuCookieStatusSchema = cookieStatusSchema

export const accountIdParamsSchema = z.object({ id: z.string().min(1) })
