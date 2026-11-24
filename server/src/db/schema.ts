import type { Database } from './types.js'

/**
 * v2 之前会话正文是 `chats.data` 里的整块 JSON。拆分成消息行时按原顺序写入，
 * `position` 保留客户端数组顺序，`revision` 统一记为 1（等同于会话初始版本）。
 */
export const splitLegacySessions = (db: Database): void => {
  const rows = db.prepare('SELECT id, user_id, data FROM chats').all() as {
    id: string
    user_id: string
    data: string
  }[]
  const insert = db.prepare(
    `INSERT OR REPLACE INTO chat_messages (user_id, chat_id, id, revision, position, role, data)
     VALUES (?, ?, ?, 1, ?, ?, ?)`
  )
  const updateCount = db.prepare('UPDATE chats SET message_count = ? WHERE user_id = ? AND id = ?')
  const updateRoot = db.prepare('UPDATE chats SET root_message_id = ? WHERE user_id = ? AND id = ?')
  for (const row of rows) {
    if (row.data === '') {
      continue
    }
    let parsed: { messages?: unknown }
    try {
      parsed = JSON.parse(row.data) as { messages?: unknown }
    } catch {
      continue
    }
    const messages = Array.isArray(parsed.messages) ? parsed.messages : []
    const legacyRoot = (parsed as { rootMessageId?: unknown }).rootMessageId
    const fallbackRoot = messages
      .map((message) => (typeof message === 'object' && message !== null ? (message as { id?: unknown }).id : undefined))
      .find((id): id is string => typeof id === 'string')
    updateRoot.run(
      typeof legacyRoot === 'string' ? legacyRoot : (fallbackRoot ?? null),
      row.user_id,
      row.id
    )
    messages.forEach((message, position) => {
      if (typeof message !== 'object' || message === null) {
        return
      }
      const item = message as { id?: unknown; role?: unknown }
      if (typeof item.id !== 'string' || typeof item.role !== 'string') {
        return
      }
      insert.run(row.user_id, row.id, item.id, position, item.role, JSON.stringify(message))
    })
    updateCount.run(messages.length, row.user_id, row.id)
  }
}

/**
 * 迁移按 user_version 递增执行，每一步都在事务里完成，失败整体回滚。
 * 只追加步骤，不修改已发布的步骤。
 */
type Migration = { version: number; up: (db: Database) => void }

const migrations: Migration[] = [
  {
    version: 1,
    up: (db) => {
      db.exec(`
        CREATE TABLE users (
          id TEXT PRIMARY KEY,
          username TEXT NOT NULL,
          username_normalized TEXT NOT NULL UNIQUE,
          password_hash TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          password_changed_at INTEGER NOT NULL,
          last_login_at INTEGER
        );

        CREATE TABLE auth_sessions (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          token_hash TEXT NOT NULL UNIQUE,
          created_at INTEGER NOT NULL,
          last_used_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL,
          revoked_at INTEGER,
          ip TEXT,
          user_agent TEXT
        );
        CREATE INDEX idx_auth_sessions_user ON auth_sessions(user_id);
        CREATE INDEX idx_auth_sessions_expires ON auth_sessions(expires_at);

        CREATE TABLE auth_throttle (
          scope TEXT PRIMARY KEY,
          failures INTEGER NOT NULL DEFAULT 0,
          window_started_at INTEGER NOT NULL,
          locked_until INTEGER NOT NULL DEFAULT 0,
          updated_at INTEGER NOT NULL
        );

        CREATE TABLE auth_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          at INTEGER NOT NULL,
          type TEXT NOT NULL,
          user_id TEXT,
          username TEXT,
          ip TEXT,
          detail TEXT
        );
        CREATE INDEX idx_auth_events_at ON auth_events(at);
        CREATE INDEX idx_auth_events_type ON auth_events(type, at);
      `)
    },
  },
  {
    version: 2,
    up: (db) => {
      // 会话正文整体存 JSON：与前端 Session 类型一一对应，改动前端数据结构时不用改表结构。
      // 列表只需要元数据，所以把 title / updated_at / version 提成独立列并建索引，避免读详情。
      db.exec(`
        CREATE TABLE chats (
          id TEXT NOT NULL,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          title TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          version INTEGER NOT NULL,
          message_count INTEGER NOT NULL DEFAULT 0,
          data TEXT NOT NULL,
          -- 会话 ID 由客户端生成：按用户隔离，避免两个账号用同一个 ID 互相顶掉
          PRIMARY KEY (user_id, id)
        );
        CREATE INDEX idx_chats_user_updated ON chats(user_id, updated_at DESC);

        -- 会话引用了哪些附件：删除会话时据此判断原件是否还有别处引用
        CREATE TABLE chat_files (
          user_id TEXT NOT NULL,
          chat_id TEXT NOT NULL,
          file_id TEXT NOT NULL,
          PRIMARY KEY (user_id, chat_id, file_id),
          FOREIGN KEY (user_id, chat_id) REFERENCES chats(user_id, id) ON DELETE CASCADE
        );
        CREATE INDEX idx_chat_files_file ON chat_files(file_id);

        -- 附件原件元数据；文件本体落在 DATA_DIR 下的用户目录里
        CREATE TABLE user_files (
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          id TEXT NOT NULL,
          size INTEGER NOT NULL,
          mime TEXT NOT NULL DEFAULT '',
          created_at INTEGER NOT NULL,
          PRIMARY KEY (user_id, id)
        );
        CREATE INDEX idx_user_files_user ON user_files(user_id);
      `)
    },
  },
  {
    version: 3,
    up: (db) => {
      // 消息按行存：流式生成时只更新「正在生成的那一条」，而不是整份会话 JSON。
      // revision 是服务端分配的单调版本号（等于写入时的 chats.version），客户端据此增量拉取。
      db.exec(`
        CREATE TABLE chat_messages (
          user_id TEXT NOT NULL,
          chat_id TEXT NOT NULL,
          id TEXT NOT NULL,
          revision INTEGER NOT NULL,
          position INTEGER NOT NULL,
          role TEXT NOT NULL,
          data TEXT NOT NULL,
          PRIMARY KEY (user_id, chat_id, id),
          FOREIGN KEY (user_id, chat_id) REFERENCES chats(user_id, id) ON DELETE CASCADE
        );
        CREATE INDEX idx_chat_messages_rev ON chat_messages(user_id, chat_id, revision);
        CREATE INDEX idx_chat_messages_pos ON chat_messages(user_id, chat_id, position);

        -- 删除墓碑：客户端增量拉取时要能知道「这条消息被删了」
        CREATE TABLE chat_message_deletions (
          user_id TEXT NOT NULL,
          chat_id TEXT NOT NULL,
          id TEXT NOT NULL,
          revision INTEGER NOT NULL,
          created_at INTEGER NOT NULL,
          PRIMARY KEY (user_id, chat_id, id),
          FOREIGN KEY (user_id, chat_id) REFERENCES chats(user_id, id) ON DELETE CASCADE
        );
        CREATE INDEX idx_chat_message_deletions_rev
          ON chat_message_deletions(user_id, chat_id, revision);
      `)
      db.exec('ALTER TABLE chats ADD COLUMN root_message_id TEXT')
      splitLegacySessions(db)
      // 正文已经拆成行，老的整体 JSON 列不再需要
      db.exec('ALTER TABLE chats DROP COLUMN data')
    },
  },
  {
    version: 4,
    up: (db) => {
      // 会话分享：一条公开链接对应一份只读快照。
      // 令牌是唯一凭据（分享页不要求登录），每个会话只保留一条记录，重复分享沿用原令牌。
      db.exec(`
        CREATE TABLE chat_shares (
          token TEXT PRIMARY KEY,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          chat_id TEXT NOT NULL,
          title TEXT NOT NULL,
          data TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          UNIQUE (user_id, chat_id),
          FOREIGN KEY (user_id, chat_id) REFERENCES chats(user_id, id) ON DELETE CASCADE
        );
        CREATE INDEX idx_chat_shares_chat ON chat_shares(user_id, chat_id);
      `)
    },
  },
  {
    version: 5,
    up: (db) => {
      // 未登录访客的每日对话额度：按「日期 + IP」累计，写进库而不是内存，
      // 进程重启或换实例都不会把已经用掉的次数清零。
      db.exec(`
        CREATE TABLE guest_usage (
          day TEXT NOT NULL,
          ip TEXT NOT NULL,
          messages INTEGER NOT NULL DEFAULT 0,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (day, ip)
        );
        CREATE INDEX idx_guest_usage_updated ON guest_usage(updated_at);
      `)
    },
  },
  {
    version: 6,
    up: (db) => {
      // 管理员动态配置（免费对话开关、每日次数、附件/搜索/思考权限）、按 IP 的规则覆盖与免登录会话详情日志
      db.exec(`
        CREATE TABLE app_settings (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        );

        CREATE TABLE guest_ip_rules (
          ip TEXT PRIMARY KEY,
          daily_limit INTEGER,
          blocked INTEGER NOT NULL DEFAULT 0,
          note TEXT NOT NULL DEFAULT '',
          updated_at INTEGER NOT NULL
        );

        CREATE TABLE guest_logs (
          id TEXT PRIMARY KEY,
          day TEXT NOT NULL,
          ip TEXT NOT NULL,
          session_id TEXT NOT NULL,
          user_agent TEXT,
          model TEXT NOT NULL,
          thinking INTEGER NOT NULL DEFAULT 0,
          search INTEGER NOT NULL DEFAULT 0,
          attachments TEXT NOT NULL DEFAULT '[]',
          user_content TEXT NOT NULL DEFAULT '',
          assistant_content TEXT NOT NULL DEFAULT '',
          assistant_thinking TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL DEFAULT 'done',
          stop_reason TEXT,
          input_tokens INTEGER,
          output_tokens INTEGER,
          error_message TEXT,
          created_at INTEGER NOT NULL,
          finished_at INTEGER
        );
        CREATE INDEX idx_guest_logs_created ON guest_logs(created_at DESC);
        CREATE INDEX idx_guest_logs_ip_created ON guest_logs(ip, created_at DESC);
        CREATE INDEX idx_guest_logs_session ON guest_logs(session_id, created_at ASC);
        CREATE INDEX idx_guest_logs_day ON guest_logs(day);
      `)
    },
  },
  {
    version: 7,
    up: (db) => {
      // 用户头像（前端裁切后以 base64 Data URL 持久化）
      db.exec(`ALTER TABLE users ADD COLUMN avatar TEXT;`)
    },
  },
]

export const migrate = (db: Database): void => {
  const current = Number(db.pragma('user_version', { simple: true }) ?? 0)
  for (const migration of migrations) {
    if (migration.version <= current) {
      continue
    }
    const run = db.transaction(() => {
      migration.up(db)
      db.pragma(`user_version = ${migration.version}`)
    })
    run()
  }
}
