# chat-web 后端服务

Node.js 22 + TypeScript + Fastify + SQLite。为 `chat-web` 前端提供：

1. **账号登录校验**：只认 `.env` 里配置的**一个**个人账号（不开放注册），支持登录、退出、查看并踢掉某台设备；
2. **会话与附件托管**：会话标题、正文、附件原件都存在服务端，同一账号多台设备共享同一份历史；
3. **聊天代理**：把浏览器对 DeepSeek 的请求转发出去，API Key 只留在服务端；
4. **访客额度**：未登录也能先聊几句，按 IP 每天限次（`GUEST_DAILY_MESSAGES`，默认 10），次数记在 SQLite 里。

## 快速开始

```sh
cd server
pnpm install      # 或 npm install
cp .env.example .env
pnpm dev          # 默认 http://127.0.0.1:8787
```

打开 `.env` 填上唯一账号的用户名与口令即可登录，不需要建表、建号：

```sh
AUTH_USERNAME=你的用户名
AUTH_PASSWORD=一个足够长的随机口令
```

改完重启生效（`pnpm dev` 会监视 `.env`，保存即自动重启；生产环境手动重启）。口令只在服务端使用，前端拿不到。

**改了口令就等于踢掉所有设备**：启动时若发现库里的散列和 `.env` 口令对不上，会吊销该账号的全部登录态并写审计事件，每台设备都必须用新口令重新登录。

自测：

```sh
pnpm type     # 类型检查
pnpm test     # 28 个接口/安全用例
pnpm bench    # SQLite 并发实测
```

## 配置

全部通过环境变量读取，见 [.env.example](.env.example)。启动时会校验，配置非法直接拒绝启动。
重点几项：

| 变量 | 说明 |
| --- | --- |
| `DATABASE_PATH` | SQLite 文件路径，首次启动自动建表并做迁移 |
| `DEEPSEEK_API_KEY` | 配置后聊天代理才可用；前端不再需要自己的 Key |
| `TRUST_PROXY` | 在 nginx 后面必须为 `true`，否则限流按反代 IP 统计 |
| `CORS_ORIGINS` | 留空表示只允许同源；分站部署填前端域名 |
| `COOKIE_SAMESITE` | 跨站部署用 `none`（同时要 `COOKIE_SECURE=true`） |
| `AUTH_USERNAME` | 唯一账号的用户名（不区分大小写），必填 |
| `AUTH_PASSWORD` | 唯一账号的口令，必填；启动时散列后只在内存里比对 |
| `GUEST_DAILY_MESSAGES` | 未登录访客每天可用的对话次数（按 IP 计，默认 10）；`0` 表示必须登录 |

## 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 健康检查，无需登录 |
| POST | `/api/auth/login` | 登录（唯一账号，凭据来自 `.env`） |
| POST | `/api/auth/logout` | 退出当前设备 |
| GET | `/api/auth/me` | 当前用户 |
| GET | `/api/auth/sessions` | 当前账号的在线设备列表 |
| DELETE | `/api/auth/sessions/:id` | 踢掉指定设备 |
| DELETE | `/api/auth/sessions` | 踢掉其他所有设备 |
| GET | `/api/chats` | 会话标题列表（只有元数据，用于侧边栏） |
| GET | `/api/chats/:id` | 打开某个会话时才拉取全量消息 |
| GET | `/api/chats/:id/messages?since=N` | 增量：只返回版本 N 之后变化的消息与被删的 id |
| GET | `/api/chats/:id/events?since=N` | 实时推送（SSE 长连接）：建连补发 N 之后的差量，并实时推送后续写入 / 重命名 / 删除 |
| PUT | `/api/chats/:id` | 保存变更（`baseVersion` 乐观锁，只提交有变化的消息，冲突返回 409） |
| PATCH | `/api/chats/:id` | 只改标题 |
| DELETE | `/api/chats/:id` | 删除会话，并清理不再被引用的附件原件 |
| POST | `/api/chats/import` | 历史导入：事务内整库替换 |
| POST | `/api/chats/:id/share` | 生成 / 刷新会话的公开分享链接（同一会话复用同一个令牌） |
| GET | `/api/shares/:token` | 读取分享快照，**无需登录**：凭令牌即可查看 |
| PUT / GET / DELETE | `/api/files/:id` | 附件原件上传 / 下载 / 删除 |
| GET | `/api/guest/quota` | 访客当天剩余对话次数，**无需登录** |
| ALL | `/api/gateway/*` | 聊天 / 语音代理：登录用户不限次；未登录访客按 IP 每天限次，只能用对话与附件上传 |

登录态的两种传递方式：

- **Cookie（默认）**：`httpOnly` + `Secure` + `SameSite`，浏览器自动携带，前端不用碰令牌；
- **Bearer 令牌**：请求头加 `x-session-mode: bearer`，响应的 `session.token` 由前端自行保存，
  用于前后端不同站（浏览器拦截第三方 Cookie）的场景。

鉴权：`Authorization: Bearer <token>` 或 Cookie，二选一，Bearer 优先。

错误统一返回：

```json
{ "error": { "code": "unauthorized", "message": "用户名或密码不正确" } }
```

## 数据存储

| 表 / 目录 | 内容 |
| --- | --- |
| `users` / `auth_sessions` / `auth_throttle` / `auth_events` | 账号（只有一行，对应 `.env` 里那个账号）、登录态、失败计数、审计 |
| `chats` | 会话元数据（标题、时间、版本、消息数、根消息），主键 `(user_id, id)` |
| `chat_messages` | 一行一条消息（JSON + `revision` + `position`）：流式生成时只更新正在生成的那一条 |
| `chat_message_deletions` | 删除墓碑，供增量同步识别「这条被删了」，保留 7 天 |
| `chat_files` | 会话引用了哪些附件，删除会话时据此清理原件 |
| `user_files` | 附件原件元数据（大小、MIME），用于配额统计与孤儿清理 |
| `chat_shares` | 分享链接：令牌、所属会话与一份只读快照（`UNIQUE (user_id, chat_id)`，删会话时级联删除） |
| `DATA_DIR` | 附件原件，按用户分目录存放 |

消息对服务端是不透明数据：只校验 id / 角色 / 顺序，前端消息结构（分支、思考块、引用……）演进时不用改表结构。
多端并发写用版本号乐观锁，客户端按消息 id 合并后重试，详见 [多端同步设计](../docs/multi-device-sync.md)。
容量与选型见 [SQLite 并发实测](../docs/sqlite-concurrency.md)。

导入历史时：前端把 ZIP 解析到本地暂存区，再一次性调 `POST /api/chats/import` 整库替换（单事务），
随后逐个上传图片原件。

## 安全设计

| 威胁 | 做法 |
| --- | --- |
| 明文 / 弱散列存密码 | `.env` 里的口令启动时用 scrypt（N=32768, r=8, p=1，单次约 90ms）散列一次，登录只比对散列 |
| 撞库、暴力破解 | 账号级 + IP 级失败计数（落库，多实例共享），达到上限锁定 15 分钟；口令散列本身就限速到约 50 次/秒 |
| 账号枚举 | 账号不存在与密码错误返回完全相同的状态码与文案；不存在的账号也走一次同等代价的散列计算 |
| 令牌泄露 | 数据库只存令牌的 SHA-256；令牌 256 位随机；一个账号最多 10 台设备，超出淘汰最久未用 |
| 令牌被复用 | 可一键吊销其他所有设备，也可逐台踢下线；`.env` 口令一改，启动时吊销全部会话 |
| CSRF | Cookie 走 `SameSite`；跨站部署额外校验 `Origin` 白名单，非白名单来源直接 403 |
| XSS 偷令牌 | 默认用 `httpOnly` Cookie，前端拿不到令牌；响应统一 `no-store` |
| API Key 泄露 | Key 只在服务端，代理替换 `x-api-key`，并剥掉客户端的 `Authorization` / `Cookie` |
| 开放代理 | 只放行 `anthropic/v1/`、`v1/tools/`、`audio/`、`models` 前缀，其余 403 |
| 资源耗尽 | 全局 600 次/分钟/IP + 登录 10 次/分钟/IP + 单用户 8 个在途流 + 请求体上限 |
| 传输明文 | 前置 HTTPS；`helmet` 统一下发 HSTS、nosniff 等安全头 |
| 审计与取证 | `auth_events` 记录登录成功/失败/锁定/踢设备，保留 90 天后自动清理 |
| 越权访问他人数据 | 每个会话 / 附件接口都按 `user_id` 过滤；同一 id 在不同账号下互不影响（复合主键） |
| 分享链接被猜到 | 令牌是 160 位随机数（base32 风格 base64url，32 字符），先校验形状再查库；分享页只返回分享时定格的快照，不暴露会话实时状态；删掉会话时链接立即失效 |
| 附件撑爆磁盘 | 单文件上限 `FILE_MAX_MB`、单账号配额 `FILES_QUOTA_MB`、无人引用的原件一天后自动清理 |

## 部署

容器化（本地或单机）用仓库根目录的 compose 一键起：`docker compose up -d --build`，
由 nginx 容器托管前端并把 `/api` 反代给本服务，见根目录 [README](../README.md#docker-部署本地--单机)。

不用容器时直接跑：

```sh
pnpm build && NODE_ENV=production node dist/main.js
```

nginx 片段（同源部署，静态文件由 nginx 提供，接口转发给本服务）：

```nginx
server {
  listen 443 ssl http2;
  server_name chat.example.com;
  root /srv/chat-web/dist;

  location /api/ {
    proxy_pass http://127.0.0.1:8787;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_http_version 1.1;
    # SSE 必须关掉缓冲，否则回复会攒到最后一次性出现
    proxy_buffering off;
    proxy_read_timeout 900s;
  }
}
```

要点：

- 必须 HTTPS，否则 `Secure` Cookie 不会下发；
- `proxy_buffering off` + `proxy_read_timeout` 加大，流式回复才正常；
- 只起**一个** Node 进程（SQLite 单写者更省心，十余人规模完全够）；确实要多进程时，
  WAL + `busy_timeout` 已能工作，但会多出写锁排队，见 [并发分析](../docs/sqlite-concurrency.md)。
- 备份：`.sqlite` + `-wal` + `-shm` 三个文件，或 `sqlite3 data.sqlite ".backup snapshot.sqlite"`；
  附件在 `DATA_DIR`，务必和库一起备份。`data/` 目录已加入 `.gitignore`。

## 目录

```text
src/
  auth/          口令散列、唯一账号、令牌、路由与鉴权钩子
  db/            SQLite 连接、迁移与仓储（用户 / 登录态 / 会话 / 附件 / 审计）
  storage/       附件原件的文件系统读写
  routes/        健康检查、会话与附件接口、聊天代理
  lib/           错误类型、日志脱敏、时间工具
scripts/         SQLite 并发实测
test/            接口与安全用例（node:test）
```
