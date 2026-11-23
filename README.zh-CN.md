# chat-web

[English](README.md) | 简体中文

基于 DeepSeek API 的聊天前端。**默认是纯静态站点**：会话、附件与 API Key 全部保存在浏览器本地，不需要任何后端；
需要「一个账号、多端同步」时，再启用仓库自带的 Fastify 后端做私有化部署。

- **在线 Demo**：<https://aidenx0704.github.io/chat-web/> —— GitHub Pages 上的纯静态版本，数据只写进你自己的浏览器（IndexedDB），不经过任何服务器；
- **零后端**：解压 `dist/` 双击 `index.html` 即可使用，也可以丢到任意静态托管；
- **可选后端**：单账号登录、API Key 托管、多端实时同步、会话外链分享、访客额度、大表格解析（仅私有化部署时启用）。

> 界面、交互与协议解析基于 [deepseek-ai/chat-demo](https://github.com/deepseek-ai/chat-demo)（MIT）二次开发，
> 本项目在其之上补了后端、多端同步、会话分享、表格解析与 Docker 部署，详见[致谢](#致谢)。

## 目录

- [纯静态使用（默认）](#纯静态使用默认)
- [启用后端（私有化部署）](#启用后端私有化部署)
- [后端与多端实时同步](#后端与多端实时同步)
- [功能](#功能)
- [数据与隐私](#数据与隐私)
- [开发](#开发)
- [贡献](#贡献)
- [免责声明](#免责声明)
- [致谢](#致谢)
- [许可证](#许可证)

## 纯静态使用（默认）

### 在线试用

打开 <https://aidenx0704.github.io/chat-web/> ，在「设置」里填入自己的 [DeepSeek API Key](https://platform.deepseek.com/api_keys) 即可开始对话。
这个版本没有后端：对话、附件与 Key 都存在当前浏览器的 IndexedDB / localStorage 里，换浏览器或清空站点数据就会消失。

### 本地构建

准备 Node.js 22.12+ 和 pnpm：

```sh
git clone https://github.com/AidenX0704/chat-web.git
cd chat-web
pnpm install
pnpm dev:static     # 纯静态开发，打开 http://localhost:8090
pnpm build:static   # 构建纯静态产物到 dist/
```

`dist/` 是完整的静态站点：解压后双击 `index.html` 就能用（浏览器需支持 `file://` 下的 IndexedDB，
且 API 服务需允许该来源的跨域请求）；托管到任意静态服务器时，直接把 `dist/` 当成站点根目录即可。

> 静态模式下发送对话、上传附件、使用语音功能时，相应内容会提交给 DeepSeek 的 API 服务；
> 除该 API 之外不存在第三方服务器。

## 启用后端（私有化部署）

后端提供这些纯静态模式做不到的能力：

- **唯一账号登录**：只认 `server/.env` 里的 `AUTH_USERNAME` / `AUTH_PASSWORD`，不开放注册，失败次数锁定、设备列表与逐台踢下线；
- **API Key 托管**：Key 只存在服务端，浏览器手里只有一个可随时吊销的登录态；
- **多端实时同步**：会话与附件存服务端 SQLite，两台设备看到同一份历史，回复边生成边同步；
- **会话外链分享**：勾选消息生成只读外链 `/s/<token>`，可撤销；
- **访客额度**：未登录也能聊几句，按 IP 每天限量，额度写进数据库；
- **大附件与表格**：附件按用户分目录存放，表格由服务端结构化入库解析。

### 本地联调

```sh
pnpm install
pnpm --dir server install
cp server/.env.example server/.env   # 在 .env 里填 DEEPSEEK_API_KEY、AUTH_USERNAME、AUTH_PASSWORD
pnpm dev                             # 同时启动后端 (:8787) 与前端 (:8090)
```

打开 http://localhost:8090 ，前端默认通过同源 `/api` 代理接入后端，无需在界面里填 Key。

生成前后端联调产物（默认同源 `/api`）：

```sh
pnpm build
```

### Docker 部署（单机）

仓库自带 [Dockerfile](Dockerfile) 与 [docker-compose.yml](docker-compose.yml)，起两个容器：

- `web`：nginx 托管前端静态文件，并把 `/api` 反代给后端；**唯一对外端口 8090**（`8090 → 容器内 80`）；
- `server`：Fastify 后端，SQLite 与附件都在 `chat-data` 卷里；只在 compose 的 `chat-net` 网络内监听 8787，**不映射到宿主**。

也就是说页面和接口共用一个端口：浏览器只访问 `8090`，页面里的 `/api` 请求由 nginx 在容器网络内转给后端，
上游 DeepSeek 调用也由后端容器自己发出，公网没有任何后端入口。

```sh
cp server/.env.example server/.env   # 填 AUTH_USERNAME / AUTH_PASSWORD / DEEPSEEK_API_KEY
docker compose up -d --build         # 首次构建几分钟，之后重启只需秒级
open http://localhost:8090           # 端口可用 WEB_PORT=xxxx 覆盖
docker compose logs -f server        # 查看后端日志

# 确认只有 8090 对外，8787 不出现在宿主
docker compose ps
ss -ltnp | grep -E '8090|8787'
curl -s http://<服务器IP>:8090/api/health   # {"status":"ok",...}
```

要点：

- `WEB_PORT`（默认 **8090**）是唯一对外端口，`8090 → 容器内 nginx:80`；后端 8787 只在 compose 的 `chat-net` 网络内监听（`expose` 而非 `ports`），宿主与公网都连不到它，所有 `/api` 请求都在容器内由 nginx 转发给后端，调试用 `docker compose exec server ...` 而不是开端口；
- 口令与 API Key 只从 `server/.env` 读取，compose 只覆盖 `HOST` / `PORT` / `TRUST_PROXY` / 数据路径等部署参数；`.dockerignore` 把 `server/.env` 挡在镜像之外；
- 本地 `http://localhost` 访问时 `COOKIE_SECURE` 默认 `false`（Secure Cookie 在 http 下不生效），挂到 HTTPS 域名后改回 `true`；
- 备份只需 `chat-data` 卷（数据库 + 附件），见 [server/README.md](server/README.md)；
- 国内网络拉依赖慢可换镜像源：`docker compose build --build-arg NPM_REGISTRY=https://registry.npmmirror.com`；
- 升级：`git pull && docker compose up -d --build`；只改 `docker/nginx.conf` 时需要重建 web 镜像（`docker compose up -d --build web`），构建后用 `docker compose exec web nginx -t` 可先校验语法。

> compose 的项目名保持为 `chat-personal`，因为命名卷跟项目名绑定（`chat-personal_chat-data`）：
> 从旧部署升级时卷能继续沿用；如果你希望一并改名，请先迁移卷里的数据，否则看起来像「历史对话全没了」。

### 用宿主 nginx 做 HTTPS 入口

服务器上已经有 nginx 时，让它终止 TLS、把请求转给容器的 8090 即可，参考 [docker/nginx-host.example.conf](docker/nginx-host.example.conf)（已校验语法）：

```sh
# 1. 让容器只监听回环，避免 8090 直接暴露到公网
echo 'WEB_BIND=127.0.0.1' >> .env
echo 'COOKIE_SECURE=true' >> .env          # 走 HTTPS 后 Secure Cookie 才会下发
docker compose up -d

# 2. 申请证书（certbot webroot 方式）
sudo mkdir -p /var/www/certbot
sudo certbot certonly --webroot -w /var/www/certbot -d chat.example.com

# 3. 放配置并生效
sudo cp docker/nginx-host.example.conf /etc/nginx/conf.d/chat-web.conf
sudo vi /etc/nginx/conf.d/chat-web.conf    # 改成自己的域名与证书路径
sudo nginx -t && sudo nginx -s reload
```

自己那份配置至少要满足这三点，否则会出现「能登录但回复一次性刷出来」「大附件传不上去」：

| 项目 | 为什么 |
| --- | --- |
| `proxy_set_header Host $host;` | 后端用 `Origin` 与 `Host` 比对做同源 CSRF 校验，Host 改了会 403 |
| `proxy_buffering off;` + `proxy_read_timeout 900s;` | `/api` 里有 SSE 长连接，缓冲会让流式回复攒到最后才显示 |
| `client_max_body_size 120m;` | 默认 1m，超过就直接 413，附件传不上去 |

另外建议 `proxy_http_version 1.1;` 与 `proxy_set_header Connection "";`，让外层与容器之间复用长连接。

HTTP/2 的写法跟版本有关：**nginx ≥ 1.25.1** 才能用独立的 `http2 on;`，更老的版本只认 `listen 443 ssl http2;`
（示例配置用的是后者，任何版本都能过 `nginx -t`）。用 `nginx -v` 先确认版本，否则会看到
`unknown directive "http2"`。

#### 首次签发证书的顺序（502 这类问题基本都出在这）

Let's Encrypt 的 HTTP-01 校验要求 `http://域名/.well-known/acme-challenge/<token>` 能直接返回文件内容。常见两种失败：

- 校验请求被代理到容器后又返回 502 → 说明 `127.0.0.1:8090` 没有响应（容器没起、崩了、或端口变了）。先查，再签：

```sh
docker compose ps                 # web 是否 running/healthy
docker compose logs --tail=50 web
curl -i http://127.0.0.1:8090/api/health
ss -ltnp | grep 8090
```

- 同域名存在两份 `server` 块（例如以前留下的旧配置文件还在）→ nginx 按文件名顺序取第一个，你新加的 `.well-known` 规则可能根本没生效。删掉旧文件再 reload。

顺序如下（此时**不要**先放带 ssl 的配置，证书还不存在，`nginx -t` 会直接失败）：

```sh
sudo mkdir -p /var/www/certbot

# 1. 先上临时配置（只占 80，把校验目录指向 /var/www/certbot）
sudo cp docker/nginx-cert-bootstrap.conf /etc/nginx/conf.d/chat-web.conf
sudo vi /etc/nginx/conf.d/chat-web.conf          # 确认 server_name 是你的域名
sudo nginx -t && sudo nginx -s reload

# 2. 自检校验目录能被访问（应返回 404 而不是 502/200 页面）
curl -i http://chat.example.com/.well-known/acme-challenge/ping

# 3. 签证书
sudo certbot certonly --webroot -w /var/www/certbot -d chat.example.com

# 4. 换成带 443 的正式配置
sudo cp docker/nginx-host.example.conf /etc/nginx/conf.d/chat-web.conf
sudo vi /etc/nginx/conf.d/chat-web.conf          # 证书路径 / 域名
sudo nginx -t && sudo nginx -s reload
```

`.well-known` 那条 `location` 要一直保留（正式配置里已有），否则三个月后续期同样会失败；续期后自动 reload 可加：

```sh
sudo certbot renew --deploy-hook "nginx -s reload" --dry-run
```

### 拉不到 Docker Hub 时（境内服务器）

典型报错：`load metadata for docker.io/library/node:22-bookworm-slim` / `i/o timeout`。两种解法：

1）给 Docker 配镜像源，一次配好长期有效（阿里云 ECS 用「容器镜像服务 → 镜像加速器」给的专属地址）：

```sh
sudo mkdir -p /etc/docker
sudo tee /etc/docker/daemon.json >/dev/null <<'EOF'
{ "registry-mirrors": ["https://<你的加速器ID>.mirror.aliyuncs.com"] }
EOF
sudo systemctl daemon-reload && sudo systemctl restart docker
```

2）不改 daemon，直接覆盖基础镜像地址（compose 已参数化）：

```sh
NODE_IMAGE=docker.m.daocloud.io/library/node:22-bookworm-slim \
NGINX_IMAGE=docker.m.daocloud.io/library/nginx:1.27-alpine \
NPM_REGISTRY=https://registry.npmmirror.com \
docker compose up -d --build
```

想固定下来用仓库自带的模板（复制成根目录 `.env`，compose 会自动读取，且已在 `.gitignore` 里不会提交）：

```sh
cp .env.docker.example .env
vi .env        # 把 NODE_IMAGE / NGINX_IMAGE 改成镜像站前缀，NPM_REGISTRY / DEBIAN_MIRROR 保持境内镜像
docker compose up -d --build
```

注意：**`.env` 只在项目根目录才会被 compose 自动读取**，改的是镜像与端口这类部署参数；账号、API Key 仍在 `server/.env`。

若镜像站也拉不动，可以先手动拉取再打回原名，构建时就会直接用本地镜像：

```sh
docker pull docker.m.daocloud.io/library/node:22-bookworm-slim
docker pull docker.m.daocloud.io/library/nginx:1.27-alpine
docker tag docker.m.daocloud.io/library/node:22-bookworm-slim node:22-bookworm-slim
docker tag docker.m.daocloud.io/library/nginx:1.27-alpine nginx:1.27-alpine
```

`NPM_REGISTRY` 换的是 pnpm 源，境内装依赖会快很多；若 better-sqlite3 的预编译包也下不动（走 GitHub），镜像里已备 python3/make/g++，会自动退回源码编译。

首次构建装这套工具链时要从 Deb 官方源拉索引，境内常见 200 秒以上，可用 `DEBIAN_MIRROR=mirrors.aliyun.com` 换源；这一层成功后会进入构建缓存，之后重建不再重跑。

## 后端与多端实时同步

启用后端后（详见 [server/README.md](server/README.md)）：

- **唯一账号登录**：只认 `AUTH_USERNAME` / `AUTH_PASSWORD`，不开放注册，失败次数锁定、设备列表与逐台踢下线；
- **API Key 托管**：Key 只存在服务端，浏览器手里只有一个可随时吊销的登录态；
- **多端实时同步**：会话与附件存服务端 SQLite（消息按行存），打开会话建立 `GET /api/chats/:id/events`
  SSE 长连接并配合 `since` 增量，另一台设备的回复边生成边实时同步，两台设备同时改同一会话时按消息合并、不丢消息；
- **会话外链分享**：点「分享」先在会话里勾选要分享的消息（默认全选，可去掉敏感内容），确认后生成只读外链
  （`GET /api/shares/:token`，无需登录即可读取），内容是分享时定格的快照；同一会话固定一个令牌，
  删除会话后链接立即失效，分享过的链接可在「设置 → 数据管理」里查看和撤销；
- **流式代理**：SSE 逐帧透传，文件与语音接口一并转发。

未登录也能直接开聊——按 IP 每天有 `GUEST_DAILY_MESSAGES` 次（默认 10）免费额度，
额度用完或想用全部能力时，点侧边栏的「登录」用 `server/.env` 里配置的账号登录（没有注册入口）。
访客的会话只存在本机浏览器，登录后换成服务端历史；设置中登录后新增「账号」分组，可退出其他设备、退出登录；
自定义 API Key 的输入入口自动隐藏。要改密码，改 `AUTH_PASSWORD` 后重启服务即可。

多端同步设计见 [docs/multi-device-sync.md](docs/multi-device-sync.md)，容量评估与数据库选型见 [docs/sqlite-concurrency.md](docs/sqlite-concurrency.md)。

## 功能

- 多会话、自动标题、重命名、置顶与删除；多选后可批量置顶或删除；编辑提问、重新生成和切换消息分支。
- 会话分享：点会话标题旁的「分享」或侧边栏「更多 → 分享」，先在会话中勾选要分享的消息（默认全选），
  再点「创建分享链接」并确认敏感内容提示，生成 `https://你的域名/s/<token>` 只读外链并复制到剪贴板；
  分享页顶部标注「来自分享的对话」，并提示内容由 AI 生成；同一会话再次分享沿用同一链接并刷新内容，删除会话或在「设置 → 数据管理」里撤销分享后链接立即失效；
  纯静态部署下退化为复制 Markdown 文案。
- 未登录访客每天有固定次数的免费对话（默认 10 次，按 IP 计，可在 `server/.env` 调整），侧边栏实时显示今日剩余次数。
- 侧边栏可搜索全部对话的标题与消息内容，收起/展开带过渡动画；收起后左上角保留品牌标识，
  会话列表的滚动条默认隐藏、滚动时才出现。
- 流式回答、深度思考、智能搜索、链接阅读与来源引用；支持停止和符合条件的继续生成。
- 附件上传、粘贴与拖拽，语音输入和回复朗读；移动端录音时输入框首行显示实时频谱。
- Markdown、代码高亮、KaTeX 公式和 Mermaid 图表。
- 简体中文与英文、浅色与深色主题、移动端布局、位置设置、历史导入导出。

## 数据与隐私

- **纯静态模式**：API Key 与设置保存在浏览器 localStorage；会话及附件原件保存在 IndexedDB，按浏览器用户配置和站点源（origin）隔离。清空站点数据即清空对话，仓库里不会有任何你的聊天记录。
- **后端模式**：会话与附件改存自建服务端的 SQLite，同一账号在多台设备上看到同一份历史，浏览器只缓存当前页面状态。
- 无论哪种模式，发送对话、上传附件和使用语音功能时，相应内容都会提交给配置的 API 服务（默认 DeepSeek 官方 API）。
- 本仓库**不包含任何 API Key、口令或服务器地址**：`server/.env`、`server/data/`、`dist/` 均由 `.gitignore` 排除，请勿提交。

设置中的历史导入导出使用 ZIP 格式。导入会在确认并校验成功后替换全部本地会话和附件；导出包含会话与本地可用的图片原件，不包含 API Key、设置或非图片附件原件。格式与保留范围见[历史导入导出](src/services/chat/history/README.md)。

设置 → 数据管理 → 删除所有对话，会在确认后清空全部本地会话、附件原件和未发送的草稿，停止正在生成的回复并回到新对话。API Key 和其他设置保留，已上传到 API 服务的文件不受影响。

## 开发

| 命令                | 用途                                         |
| ------------------- | -------------------------------------------- |
| `pnpm dev:static`   | 纯静态模式开发服务器（无需后端）             |
| `pnpm dev`          | 统一同时启动后端与前端开发服务器             |
| `pnpm dev:web`      | 仅启动前端开发服务器（代理 `/api` 到后端）   |
| `pnpm dev:server`   | 仅启动后端开发服务器                         |
| `pnpm build:static` | 构建纯静态模式产物到 `dist/`                 |
| `pnpm build`        | 构建前端到 `dist/`（默认同源接入后端）       |
| `pnpm build:server` | 构建后端服务                                 |
| `pnpm test:server`  | 运行后端接口与实时推送测试                   |
| `pnpm type`         | 前后端 TypeScript 类型检查                   |
| `pnpm lint`         | oxlint 检查                                  |
| `pnpm format`       | oxfmt 格式化                                 |

[rspack.config.ts](rspack.config.ts) 默认同源接入后端（`BACKEND_ORIGIN=/`，开发时由 devServer 将 `/api` 代理至 `API_PROXY_TARGET`，默认 `http://127.0.0.1:8787`）。`createConfig({ apiOrigin, backendOrigin, apiProxyTarget, devServer })` 支持自定义 API 地址、后端地址与代理目标；传 `BACKEND_ORIGIN=none` 可切回纯静态模式。

聊天默认使用 `deepseek-flash`，通过 Anthropic 兼容的 Messages / Files API 通信；语音使用 ASR / TTS 接口。请求使用搜索、链接阅读、标题和 `latest_reminder` 等扩展，接入服务需支持相应能力。附件实际支持的格式以服务端校验为准。

```text
src/
  app/                 应用布局、主题与全局样式
  components/          聊天、设置、Markdown 等界面组件
  i18n/                中英文文案
  services/
    api/               API 请求、SSE 与协议类型
    auth/              登录态、会话令牌与账号接口
    chat/              会话、消息分支、本地存储与历史导入导出
    markdown/          Markdown 解析、代码高亮与图表
    speech/            录音与朗读
  utils/               通用工具
server/                可选后端：Fastify + SQLite，登录、同步、分享与代理
docker/                nginx 反代配置（容器内同源网关 / 宿主 HTTPS 示例）
docs/                  多端同步与 SQLite 并发说明
```

## 贡献

欢迎提 issue 与 PR，开始之前请读一下 [CONTRIBUTING.md](CONTRIBUTING.md) 与 [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)。
安全问题请按 [SECURITY.md](SECURITY.md) 的方式私下报告，不要公开披露。

## 免责声明

- 本项目只提供客户端与自建代理的实现，**不附带任何 API 配额**；使用 DeepSeek API 产生的费用由你自己承担，并需遵守其[服务条款](https://platform.deepseek.com/)；
- 聊天内容由模型生成，可能存在错误；请自行甄别，不要把它当作专业意见；
- 自行部署时请遵守所在地法律法规，包括但不限于内容合规、ICP 备案与数据留存要求。

## 致谢

- 界面、交互与协议解析来自 [deepseek-ai/chat-demo](https://github.com/deepseek-ai/chat-demo)（MIT，Copyright (c) DeepSeek）；
- 本仓库在其基础上新增了可选后端（登录、多端同步、分享、访客额度、表格解析）、Docker 部署与相关文档；
- 依赖与关键第三方库：React、Rspack、Zustand、Fastify、better-sqlite3、KaTeX、Mermaid、PrismJS 等，各自遵循自己的许可证。

## 许可证

[MIT](LICENSE)。构建会将许可证复制到 `dist/LICENSE`，分发时请一并保留；第三方依赖遵循各自的许可证。
