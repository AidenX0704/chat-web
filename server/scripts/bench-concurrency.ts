/**
 * SQLite 并发能力实测：用与线上表结构同构的表，模拟「一个人多台设备 + 十几个人同时在线」的负载。
 *
 *   npm run bench
 *
 * 输出四组数据：
 *   1. 单连接写入基线（进程内串行，就是本服务单实例的实际上限）
 *   2. 多连接并发写（worker_threads 各持一个连接，检验 WAL + busy_timeout 的表现）
 *   3. 读写混合（模拟多设备同时拉会话、同时上报登录态）
 *   4. 口令散列吞吐（登录的真实 CPU 成本）
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads'
import Database from 'better-sqlite3'
import { hashPassword, verifyPassword } from '../src/auth/password.js'

type WorkloadResult = {
  writes: number
  reads: number
  busyErrors: number
  durations: number[]
  elapsedMs: number
}

const CHAT_SCHEMA = `
  CREATE TABLE IF NOT EXISTS chats (
    id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    title TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    version INTEGER NOT NULL,
    message_count INTEGER NOT NULL DEFAULT 0,
    root_message_id TEXT,
    PRIMARY KEY (user_id, id)
  );
  CREATE INDEX IF NOT EXISTS idx_chats_user_updated ON chats(user_id, updated_at DESC);
  CREATE TABLE IF NOT EXISTS chat_messages (
    user_id TEXT NOT NULL,
    chat_id TEXT NOT NULL,
    id TEXT NOT NULL,
    revision INTEGER NOT NULL,
    position INTEGER NOT NULL,
    role TEXT NOT NULL,
    data TEXT NOT NULL,
    PRIMARY KEY (user_id, chat_id, id)
  );
  CREATE INDEX IF NOT EXISTS idx_chat_messages_pos ON chat_messages(user_id, chat_id, position);
`

/** 单条消息的真实体量：一轮回答的文字大约 2KB */
const MESSAGE_JSON = JSON.stringify({
  id: 'm-x',
  role: 'assistant',
  createdAt: 1,
  model: 'deepseek-flash',
  prefix: true,
  status: 'done',
  blocks: [{ type: 'text', text: '答'.repeat(700) }],
})

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE);
  CREATE TABLE IF NOT EXISTS auth_sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    last_used_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_sessions_user ON auth_sessions(user_id);
`

const openDb = (file: string, synchronous: 'NORMAL' | 'FULL') => {
  const db = new Database(file)
  db.pragma('journal_mode = WAL')
  db.pragma(`synchronous = ${synchronous}`)
  db.pragma('busy_timeout = 5000')
  db.pragma('foreign_keys = ON')
  return db
}

const percentile = (sorted: number[], p: number): number =>
  sorted.length === 0 ? 0 : (sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0)

const runWorker = (payload: {
  file: string
  synchronous: 'NORMAL' | 'FULL'
  writes: number
  reads: number
}): Promise<WorkloadResult> =>
  new Promise((resolve, reject) => {
    const worker = new Worker(new URL(import.meta.url), {
      execArgv: ['--import', 'tsx'],
      workerData: payload,
    })
    worker.once('message', (result: WorkloadResult) => {
      resolve(result)
      void worker.terminate()
    })
    worker.once('error', reject)
  })

/** worker 侧：反复做「更新登录态 + 读一次会话」的短事务 */
const workerMain = (payload: {
  file: string
  synchronous: 'NORMAL' | 'FULL'
  writes: number
  reads: number
}): void => {
  const db = openDb(payload.file, payload.synchronous)
  if (payload.file.endsWith('chats.sqlite')) {
    const save = db.transaction((version: number) => {
      db.prepare(
        `UPDATE chat_messages SET data = ?, revision = ?
           WHERE user_id = ? AND chat_id = ? AND id = ?`
      ).run(MESSAGE_JSON, version, 'user-1', 'chat-bench', 'm-30')
      db.prepare('UPDATE chats SET version = ?, updated_at = ? WHERE user_id = ? AND id = ?').run(
        version,
        Date.now(),
        'user-1',
        'chat-bench'
      )
    })
    const durations: number[] = []
    let writes = 0
    let busyErrors = 0
    const startedAt = performance.now()
    for (let index = 0; index < payload.writes; index += 1) {
      const began = performance.now()
      try {
        save(index + 2)
        writes += 1
      } catch (error) {
        if ((error as { code?: string }).code?.startsWith('SQLITE_BUSY')) {
          busyErrors += 1
        } else {
          throw error
        }
      }
      durations.push(performance.now() - began)
    }
    db.close()
    parentPort?.postMessage({
      writes,
      reads: 0,
      busyErrors,
      durations,
      elapsedMs: performance.now() - startedAt,
    } satisfies WorkloadResult)
    return
  }

  const update = db.prepare('UPDATE auth_sessions SET last_used_at = ? WHERE id = ?')
  const read = db.prepare('SELECT * FROM auth_sessions WHERE user_id = ? LIMIT 5')
  const ids = (db.prepare('SELECT id FROM auth_sessions').all() as { id: string }[]).map((row) => row.id)
  const durations: number[] = []
  let writes = 0
  let reads = 0
  let busyErrors = 0
  const startedAt = performance.now()

  // 纯读 worker：验证 WAL 下写事务不会阻塞读
  if (payload.writes === 0) {
    for (let index = 0; index < payload.reads; index += 1) {
      const began = performance.now()
      read.all(`user-${index % 20}`)
      durations.push(performance.now() - began)
      reads += 1
    }
    db.close()
    parentPort?.postMessage({
      writes,
      reads,
      busyErrors,
      durations,
      elapsedMs: performance.now() - startedAt,
    } satisfies WorkloadResult)
    return
  }

  for (let index = 0; index < payload.writes; index += 1) {
    const id = ids[index % ids.length] as string
    const began = performance.now()
    try {
      update.run(Date.now(), id)
      writes += 1
      if (index % 4 === 0) {
        read.all('user-1')
        reads += 1
      }
    } catch (error) {
      if ((error as { code?: string }).code?.startsWith('SQLITE_BUSY')) {
        busyErrors += 1
      } else {
        throw error
      }
    }
    durations.push(performance.now() - began)
  }
  db.close()
  parentPort?.postMessage({
    writes,
    reads,
    busyErrors,
    durations,
    elapsedMs: performance.now() - startedAt,
  } satisfies WorkloadResult)
}

const seed = (file: string, sessionCount: number) => {
  const db = openDb(file, 'NORMAL')
  db.exec(SCHEMA)
  const insertUser = db.prepare('INSERT INTO users (id, username) VALUES (?, ?)')
  const insertSession = db.prepare(
    'INSERT INTO auth_sessions (id, user_id, last_used_at, expires_at) VALUES (?, ?, ?, ?)'
  )
  const now = Date.now()
  db.transaction(() => {
    for (let user = 0; user < 20; user += 1) {
      insertUser.run(`user-${user}`, `user${user}`)
    }
    for (let index = 0; index < sessionCount; index += 1) {
      insertSession.run(`session-${index}`, `user-${index % 20}`, now, now + 86_400_000)
    }
  })()
  db.close()
}

const report = (label: string, result: WorkloadResult, concurrency: number) => {
  const sorted = [...result.durations].sort((a, b) => a - b)
  const throughput = (result.writes / result.elapsedMs) * 1000
  console.log(
    `  ${label.padEnd(28)} 并发=${String(concurrency).padStart(2)}  写入=${String(result.writes).padStart(6)}  ` +
      `吞吐=${throughput.toFixed(0).padStart(6)} 次/秒  p50=${percentile(sorted, 0.5).toFixed(2)}ms  ` +
      `p99=${percentile(sorted, 0.99).toFixed(2)}ms  busy=${result.busyErrors}`
  )
}

const singleConnectionBaseline = (file: string, writes: number, synchronous: 'NORMAL' | 'FULL') => {
  const db = openDb(file, synchronous)
  const update = db.prepare('UPDATE auth_sessions SET last_used_at = ? WHERE id = ?')
  const ids = (db.prepare('SELECT id FROM auth_sessions').all() as { id: string }[]).map((row) => row.id)
  const durations: number[] = []
  const startedAt = performance.now()
  for (let index = 0; index < writes; index += 1) {
    const began = performance.now()
    update.run(Date.now(), ids[index % ids.length] as string)
    durations.push(performance.now() - began)
  }
  const elapsedMs = performance.now() - startedAt
  db.close()
  return { writes, reads: 0, busyErrors: 0, durations, elapsedMs } satisfies WorkloadResult
}

const scryptBench = async () => {
  const hashStartedAt = performance.now()
  const hash = await hashPassword('benchmark-passphrase-2026')
  const hashMs = performance.now() - hashStartedAt

  const rounds = 20
  const concurrency = 4
  const roundsPerWorker = rounds / concurrency
  const startedAt = performance.now()
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      for (let index = 0; index < roundsPerWorker; index += 1) {
        await verifyPassword('benchmark-passphrase-2026', hash)
      }
    })
  )
  const elapsedMs = performance.now() - startedAt
  console.log(
    `\n口令散列（scrypt N=32768,r=8,p=1）\n  单次计算: ${hashMs.toFixed(0)}ms  ` +
      `${concurrency} 路并发吞吐: ${((rounds / elapsedMs) * 1000).toFixed(1)} 次/秒`
  )
}

const main = async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'chat-web-bench-'))
  const file = path.join(dir, 'bench.sqlite')

  console.log('=== SQLite 并发实测（与线上表结构同构） ===\n')
  seed(file, 4000)

  console.log('[1] 单连接串行写入（本服务单实例的真实形态）')
  report('synchronous=NORMAL', singleConnectionBaseline(file, 5000, 'NORMAL'), 1)
  report('synchronous=FULL', singleConnectionBaseline(file, 2000, 'FULL'), 1)

  for (const concurrency of [4, 12, 24]) {
    console.log(`\n[2] ${concurrency} 个连接并发写（多实例 / 多进程形态）`)
    const perWorker = Math.ceil(4000 / concurrency)
    const results = await Promise.all(
      Array.from({ length: concurrency }, () =>
        runWorker({ file, synchronous: 'NORMAL', writes: perWorker, reads: perWorker })
      )
    )
    const merged: WorkloadResult = {
      writes: results.reduce((sum, item) => sum + item.writes, 0),
      reads: results.reduce((sum, item) => sum + item.reads, 0),
      busyErrors: results.reduce((sum, item) => sum + item.busyErrors, 0),
      durations: results.flatMap((item) => item.durations),
      elapsedMs: Math.max(...results.map((item) => item.elapsedMs)),
    }
    report('WAL + busy_timeout=5000', merged, concurrency)
  }

  console.log('\n[3] 读写分离：12 个读连接 + 1 个写连接（WAL 下读不阻塞）')
  const readers = Array.from({ length: 12 }, () =>
    runWorker({ file, synchronous: 'NORMAL', writes: 0, reads: 1500 })
  )
  const writerPromise = runWorker({ file, synchronous: 'NORMAL', writes: 4000, reads: 0 })
  const [writer, ...readerResults] = await Promise.all([writerPromise, ...readers])
  report('1 个写连接', writer, 1)
  const totalReads = readerResults.reduce((sum, item) => sum + item.reads, 0)
  const readElapsed = Math.max(...readerResults.map((item) => item.elapsedMs))
  const readDurations = readerResults.flatMap((item) => item.durations).sort((a, b) => a - b)
  console.log(
    `  12 个读连接合计读取 ${totalReads} 次，吞吐 ${((totalReads / readElapsed) * 1000).toFixed(0)} 次/秒，` +
      `p99=${percentile(readDurations, 0.99).toFixed(2)}ms（写连接同时满负荷）`
  )

  // 会话正文按消息行存：一次保存只碰「正在生成的那一条」
  const chatsFile = path.join(dir, 'chats.sqlite')
  {
    const db = openDb(chatsFile, 'NORMAL')
    db.exec(CHAT_SCHEMA)
    const insertChat = db.prepare(
      `INSERT INTO chats (id, user_id, title, created_at, updated_at, version, message_count, root_message_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    const insertMessage = db.prepare(
      `INSERT INTO chat_messages (user_id, chat_id, id, revision, position, role, data)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    const now = Date.now()
    db.transaction(() => {
      for (let chat = 0; chat < 200; chat += 1) {
        const chatId = chat === 0 ? 'chat-bench' : `chat-${chat}`
        insertChat.run(chatId, `user-${chat % 20}`, `会话 ${chat}`, now, now, 1, 60, 'm-0')
        for (let position = 0; position < 60; position += 1) {
          insertMessage.run(
            `user-${chat % 20}`,
            chatId,
            `m-${position}`,
            1,
            position,
            position % 2 === 0 ? 'user' : 'assistant',
            MESSAGE_JSON
          )
        }
      }
    })()
    db.close()

    console.log(
      `\n[4] 会话正文（消息按行存，单条约 ${Math.round(Buffer.byteLength(MESSAGE_JSON) / 1024)}KB，每个会话 60 条）`
    )
    report('单连接保存一条消息', await runWorker({ file: chatsFile, synchronous: 'NORMAL', writes: 2000, reads: 0 }), 1)
    for (const concurrency of [4, 12]) {
      const results = await Promise.all(
        Array.from({ length: concurrency }, () =>
          runWorker({ file: chatsFile, synchronous: 'NORMAL', writes: Math.ceil(800 / concurrency), reads: 0 })
        )
      )
      const merged: WorkloadResult = {
        writes: results.reduce((sum, item) => sum + item.writes, 0),
        reads: 0,
        busyErrors: results.reduce((sum, item) => sum + item.busyErrors, 0),
        durations: results.flatMap((item) => item.durations),
        elapsedMs: Math.max(...results.map((item) => item.elapsedMs)),
      }
      report('并发保存同一会话', merged, concurrency)
    }

    const reader = openDb(chatsFile, 'NORMAL')
    const listQuery = reader.prepare(
      'SELECT id, title, created_at, updated_at, version, message_count FROM chats WHERE user_id = ? ORDER BY updated_at DESC'
    )
    const messagesQuery = reader.prepare(
      'SELECT id, revision, position, role, data FROM chat_messages WHERE user_id = ? AND chat_id = ? ORDER BY position ASC'
    )
    const listStartedAt = performance.now()
    const list = listQuery.all('user-0')
    const listMs = performance.now() - listStartedAt
    const readStartedAt = performance.now()
    for (let index = 0; index < 200; index += 1) {
      messagesQuery.all('user-0', 'chat-bench')
    }
    const readMs = (performance.now() - readStartedAt) / 200
    reader.close()
    console.log(
      `  会话列表（${list.length} 条元数据）: ${listMs.toFixed(2)}ms；整份会话读取（60 条消息）: ${readMs.toFixed(2)}ms`
    )
  }

  await scryptBench()

  rmSync(dir, { recursive: true, force: true })
}

if (isMainThread) {
  await main()
} else {
  workerMain(workerData as { file: string; synchronous: 'NORMAL' | 'FULL'; writes: number; reads: number })
}
