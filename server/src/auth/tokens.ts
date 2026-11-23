import { createHash, randomBytes, randomUUID } from 'node:crypto'

/** 会话令牌：256 位随机数，只下发给客户端一次。 */
export const createSessionToken = (): string => randomBytes(32).toString('base64url')

/**
 * 数据库里只存令牌的 SHA-256：即使库文件泄露，也不能直接拿来冒充登录态。
 * 令牌本身是高熵随机值，不需要加盐慢散列。
 */
export const hashSessionToken = (token: string): string =>
  createHash('sha256').update(token).digest('hex')

export const createId = (): string => randomUUID()
