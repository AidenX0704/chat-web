import type { Database } from './types.js'
import type { LoginPolicy } from '../config.js'

type ThrottleRow = {
  scope: string
  failures: number
  window_started_at: number
  locked_until: number
  updated_at: number
}

/**
 * 登录失败计数落在 SQLite 里而不是内存：多实例部署时锁定状态共享，
 * 进程重启也不会把攻击者的失败次数清零。
 */
export type ThrottleRepo = ReturnType<typeof createThrottleRepo>

export const createThrottleRepo = (db: Database, policy: LoginPolicy) => {
  const select = db.prepare<[string], ThrottleRow>('SELECT * FROM auth_throttle WHERE scope = ?')
  const upsert = db.prepare(
    `INSERT INTO auth_throttle (scope, failures, window_started_at, locked_until, updated_at)
     VALUES (@scope, @failures, @windowStartedAt, @lockedUntil, @now)
     ON CONFLICT(scope) DO UPDATE SET
       failures = @failures,
       window_started_at = @windowStartedAt,
       locked_until = @lockedUntil,
       updated_at = @now`
  )
  const remove = db.prepare<[string]>('DELETE FROM auth_throttle WHERE scope = ?')
  const pruneStale = db.prepare<[number, number]>('DELETE FROM auth_throttle WHERE locked_until < ? AND updated_at < ?')

  const read = (scope: string, at: number): ThrottleRow | undefined => {
    const row = select.get(scope)
    if (!row) {
      return undefined
    }
    const windowExpired = at - row.window_started_at > policy.windowMs
    const lockExpired = row.locked_until <= at
    if (lockExpired && windowExpired) {
      remove.run(scope)
      return undefined
    }
    return row
  }

  return {
    /** 返回剩余锁定毫秒数；0 表示当前未被锁定。 */
    lockedForMs(scope: string, at: number): number {
      const row = read(scope, at)
      if (!row || row.locked_until <= at) {
        return 0
      }
      return row.locked_until - at
    },
    registerFailure(scope: string, at: number): { failures: number; lockedForMs: number } {
      const row = read(scope, at)
      const windowExpired = !row || at - row.window_started_at > policy.windowMs
      const failures = (windowExpired ? 0 : row.failures) + 1
      const windowStartedAt = windowExpired ? at : row.window_started_at
      const lockedUntil = failures >= policy.maxFailures ? at + policy.lockMs : 0
      upsert.run({
        scope,
        failures,
        windowStartedAt,
        lockedUntil,
        now: at,
      })
      return { failures, lockedForMs: lockedUntil === 0 ? 0 : lockedUntil - at }
    },
    reset(scope: string): void {
      remove.run(scope)
    },
    prune(at: number): number {
      return pruneStale.run(at, at - policy.windowMs).changes
    },
  }
}
