import { timingSafeEqual } from 'node:crypto'
import type { Config } from '../config.js'
import { normalizeUsername, toPublicUser, type PublicUser, type UserRepo } from '../db/users.js'
import { hashPassword, verifyPassword } from './password.js'
import { createId } from './tokens.js'

/**
 * 个人账号：整个服务只有 .env 里配置的那一个账号，没有注册、没有改密接口。
 * 口令在启动时做一次 scrypt 散列，登录只比对散列值——明文口令不会离开进程内存。
 */
export type PersonalAccount = {
  user: PublicUser
  /**
   * 本次启动是否检测到 .env 口令变更（与库里上次同步的散列对不上）。
   * 变更意味着「口令已更换」，调用方必须吊销该账号的全部登录态。
   */
  passwordChanged: boolean
  /** 用户名与口令都匹配才返回 true；任何一项不对都走同一条失败路径 */
  verify: (username: string, password: string) => Promise<boolean>
}

/** 定长比较，避免用比较耗时反推用户名 */
const safeEqual = (expected: string, actual: string): boolean => {
  const left = Buffer.from(expected, 'utf8')
  const right = Buffer.from(actual, 'utf8')
  return left.length === right.length && timingSafeEqual(left, right)
}

export const loadPersonalAccount = async ({
  config,
  users,
  at,
}: {
  config: Config
  users: UserRepo
  at: number
}): Promise<PersonalAccount> => {
  const username = config.account.username
  const passwordHash = await hashPassword(config.account.password)
  const existing = users.findByUsername(username)
  // 库里的散列对不上 .env 口令 → 口令被改过（或库里还是更早的部署留下的）
  const passwordChanged =
    existing !== undefined &&
    !(await verifyPassword(config.account.password, existing.password_hash)).ok
  const row = users.upsertPersonal({ id: createId(), username, passwordHash, now: at })
  const expected = normalizeUsername(username)

  return {
    user: toPublicUser(row),
    passwordChanged,
    async verify(inputUsername, password) {
      const nameMatches = safeEqual(expected, normalizeUsername(inputUsername))
      // 用户名不对也要跑完 scrypt，响应时间不泄露「用户名是否正确」
      const verdict = await verifyPassword(password, passwordHash)
      return nameMatches && verdict.ok
    },
  }
}
