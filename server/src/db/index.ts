import { mkdirSync } from 'node:fs'
import path from 'node:path'
import BetterSqlite3 from 'better-sqlite3'
import { migrate } from './schema.js'
import type { Database } from './types.js'

export type { Database } from './types.js'

/**
 * 打开数据库并应用运行期参数。
 *
 * - journal_mode=WAL：读不阻塞写、写不阻塞读，多设备同时拉取会话时不会互相排队；
 * - synchronous=NORMAL：WAL 下只在 checkpoint 时 fsync，写入吞吐量约为 FULL 的数倍，
 *   代价是宿主机掉电而非进程崩溃时可能丢失最后若干个事务（登录态可接受）；
 * - busy_timeout：多个进程同时写时自动重试等待，而不是立刻报 SQLITE_BUSY；
 * - foreign_keys=ON：删除用户时级联清理会话。
 */
export const openDatabase = (file: string): Database => {
  const absolute = file === ':memory:' ? file : path.resolve(file)
  if (absolute !== ':memory:') {
    mkdirSync(path.dirname(absolute), { recursive: true })
  }
  const db = new BetterSqlite3(absolute)
  db.pragma('journal_mode = WAL')
  db.pragma('synchronous = NORMAL')
  db.pragma('busy_timeout = 5000')
  db.pragma('foreign_keys = ON')
  db.pragma('temp_store = MEMORY')
  db.pragma('cache_size = -16000')
  migrate(db)
  return db
}
