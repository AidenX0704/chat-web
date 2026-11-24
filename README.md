# chat-web

English | [简体中文](README.zh-CN.md)

A chat front-end for the DeepSeek API. **Static by default**: conversations, attachments and your API key stay in the browser, with no backend at all. Enable the bundled Fastify backend only when you want one account synced across devices (self-hosting).

- **Live demo**: <https://aidenx0704.github.io/chat-web/> — the static build running on GitHub Pages; everything is written to your own browser (IndexedDB), nothing goes through a server of ours;
- **No backend**: extract `dist/` and double-click `index.html`, or drop it on any static host;
- **Optional backend**: single-account sign-in, server-side API key, real-time multi-device sync, public share links, guest quota, large spreadsheet parsing (self-hosting only).

> The UI, interactions and protocol handling come from [deepseek-ai/chat-demo](https://github.com/deepseek-ai/chat-demo) (MIT).
> This fork adds the optional backend, multi-device sync, chat sharing, spreadsheet parsing and Docker deployment — see [Credits](#credits).

## Contents

- [Static usage (default)](#static-usage-default)
- [Enabling the backend (self-hosting)](#enabling-the-backend-self-hosting)
- [Backend and real-time multi-device sync](#backend-and-real-time-multi-device-sync)
- [Features](#features)
- [Data and privacy](#data-and-privacy)
- [Development](#development)
- [Contributing](#contributing)
- [Disclaimer](#disclaimer)
- [Credits](#credits)
- [License](#license)

## Static usage (default)

### Try it online

Open <https://aidenx0704.github.io/chat-web/> and paste your own [DeepSeek API key](https://platform.deepseek.com/api_keys) in Settings.
That build has no backend: chats, attachments and the key live in the current browser's IndexedDB / localStorage,
so switching browsers or clearing site data clears them.

### Build it locally

Install Node.js 22.12+ and pnpm:

```sh
git clone https://github.com/AidenX0704/chat-web.git
cd chat-web
pnpm install
pnpm dev:static     # static dev server on http://localhost:8090
pnpm build:static   # static build into dist/
```

`dist/` is a complete static site: extract it and double-click `index.html` (the browser must support IndexedDB on
`file://` pages and the API service must allow that origin), or serve `dist/` as the site root on any static host.

> In static mode, sending a message, uploading an attachment or using speech sends that content to the configured
> DeepSeek API. No other third-party server is involved.

## Enabling the backend (self-hosting)

The backend adds what a static site cannot do:

- **Single account** — only the `AUTH_USERNAME` / `AUTH_PASSWORD` pair from `server/.env`, no sign-up, with lockout after repeated failures, a device list and per-device revocation;
- **Server-side API key** — the key never reaches the browser, which only holds a revocable session;
- **Multi-device sync** — conversations and attachments live in server-side SQLite; two devices see the same history and replies stream while they are generated;
- **Public share links** — pick messages, mint a read-only `/s/<token>` link, revoke it later;
- **Guest quota** — visitors can chat a few messages per day per IP, counted in the database;
- **Large attachments and spreadsheets** — attachments are stored per user; spreadsheets are parsed into the database.

### Local development with the backend

```sh
pnpm install
pnpm --dir server install
cp server/.env.example server/.env   # set DEEPSEEK_API_KEY, AUTH_USERNAME, AUTH_PASSWORD
pnpm dev                             # backend (:8787) and frontend (:8090) together
```

Open http://localhost:8090; the frontend connects to the backend through the same-origin `/api` proxy, so no key is needed in the UI.

To build the same-origin (backend) frontend:

```sh
pnpm build
```

### Docker deployment (single host)

The repo ships a [Dockerfile](Dockerfile) and [docker-compose.yml](docker-compose.yml) with two containers:

- `web` — nginx serves the built frontend and proxies `/api` to the backend; **the only published port is 8090** (`8090 → 80` in the container);
- `server` — the Fastify backend; SQLite and attachments live in the `chat-data` volume and it listens on 8787 inside the Compose `chat-net` network only, **never published to the host**.

So the UI and the API share one port: browsers only touch `8090`, every `/api` call is forwarded by nginx inside the container network,
and upstream DeepSeek traffic leaves from the backend container itself — nothing on the public side can reach the API directly.

```sh
cp server/.env.example server/.env   # set AUTH_USERNAME / AUTH_PASSWORD / DEEPSEEK_API_KEY
docker compose up -d --build         # first build takes a few minutes, restarts take seconds
open http://localhost:8090           # change the port with WEB_PORT=xxxx
docker compose logs -f server        # follow backend logs

# confirm only 8090 is published; 8787 must not appear on the host
docker compose ps
ss -ltnp | grep -E '8090|8787'
curl -s http://<server-ip>:8090/api/health   # {"status":"ok",...}
```

Notes:

- `WEB_PORT` (default **8090**) is the only published port (`8090 → nginx:80` in the container); the backend listens on 8787 inside the Compose `chat-net` network only (`expose`, never `ports`), so neither the host nor the internet can reach it — every `/api` call is proxied to it by nginx inside the network, and debugging uses `docker compose exec server ...` instead of a published port;
- credentials and the upstream API key are read from `server/.env` only; Compose just overrides deployment values (`HOST`, `PORT`, `TRUST_PROXY`, data paths) and `.dockerignore` keeps that file out of the image;
- for plain `http://localhost` access `COOKIE_SECURE` defaults to `false` (Secure cookies are not sent over http); set it back to `true` behind HTTPS;
- back up the `chat-data` volume (database plus attachments), see [server/README.md](server/README.md);
- on slow networks switch registries: `docker compose build --build-arg NPM_REGISTRY=https://registry.npmmirror.com`;
- upgrade with `git pull && docker compose up -d --build`; when only `docker/nginx.conf` changes rebuild the web image (`docker compose up -d --build web`) — `docker compose exec web nginx -t` validates the config first.

> The Compose project name stays `chat-personal` because named volumes are bound to it (`chat-personal_chat-data`),
> so upgrades from an older deployment keep their data. If you want to rename it as well, migrate the volume first —
> otherwise existing conversations appear to be gone.

### Putting host nginx in front (HTTPS)

If the server already runs nginx, let it terminate TLS and forward to the container's 8090 — see [docker/nginx-host.example.conf](docker/nginx-host.example.conf) (syntax-checked):

```sh
# 1. bind the container to loopback so 8090 is never reachable from the internet
echo 'WEB_BIND=127.0.0.1' >> .env
echo 'COOKIE_SECURE=true' >> .env          # required for Secure cookies over HTTPS
docker compose up -d

# 2. obtain a certificate (certbot webroot)
sudo mkdir -p /var/www/certbot
sudo certbot certonly --webroot -w /var/www/certbot -d chat.example.com

# 3. install and reload
sudo cp docker/nginx-host.example.conf /etc/nginx/conf.d/chat-web.conf
sudo vi /etc/nginx/conf.d/chat-web.conf        # set your domain and certificate paths
sudo nginx -t && sudo nginx -s reload
```

Three settings any hand-written config needs, otherwise you get "login works but replies appear all at once" or failed uploads:

| Setting | Why |
| --- | --- |
| `proxy_set_header Host $host;` | the backend compares `Origin` with `Host` for same-origin CSRF checks; rewriting Host yields 403 |
| `proxy_buffering off;` + `proxy_read_timeout 900s;` | `/api` carries SSE streams; buffering collapses them into one final burst |
| `client_max_body_size 120m;` | the default 1m rejects attachments with 413 |

Also keep `proxy_http_version 1.1;` and `proxy_set_header Connection "";` so the outer layer reuses keep-alive connections to the container.

HTTP/2 syntax depends on the version: a standalone `http2 on;` requires **nginx ≥ 1.25.1**; older builds only accept
`listen 443 ssl http2;` (the example uses the compatible form). Check with `nginx -v` first, otherwise nginx reports
`unknown directive "http2"`.

#### Issuing the first certificate (where 502 usually comes from)

Let's Encrypt HTTP-01 needs `http://<domain>/.well-known/acme-challenge/<token>` to return the file content directly. Two common failures:

- The challenge is proxied to the container and comes back 502 → `127.0.0.1:8090` is not answering (container down, crash-looping, or a different port). Check first:

```sh
docker compose ps                 # is web running/healthy?
docker compose logs --tail=50 web
curl -i http://127.0.0.1:8090/api/health
ss -ltnp | grep 8090
```

- Two `server` blocks claim the same domain (a leftover config file, for example) → nginx uses the first by file order and your new `.well-known` rule never applies. Delete the old file and reload.

Order matters — do **not** install the ssl config first, it references certificates that do not exist yet and `nginx -t` fails:

```sh
sudo mkdir -p /var/www/certbot

# 1. temporary HTTP-only config that serves the challenge directory
sudo cp docker/nginx-cert-bootstrap.conf /etc/nginx/conf.d/chat-web.conf
sudo vi /etc/nginx/conf.d/chat-web.conf          # set your server_name
sudo nginx -t && sudo nginx -s reload

# 2. the challenge path must return 404, not 502 and not an HTML page
curl -i http://chat.example.com/.well-known/acme-challenge/ping

# 3. issue the certificate
sudo certbot certonly --webroot -w /var/www/certbot -d chat.example.com

# 4. switch to the TLS config
sudo cp docker/nginx-host.example.conf /etc/nginx/conf.d/chat-web.conf
sudo vi /etc/nginx/conf.d/chat-web.conf          # domain and certificate paths
sudo nginx -t && sudo nginx -s reload
```

Keep the `.well-known` location in the final config (it is already there), otherwise renewals fail in three months. To reload automatically after renewal:

```sh
sudo certbot renew --deploy-hook "nginx -s reload" --dry-run
```

### When Docker Hub is unreachable

Typical error: `load metadata for docker.io/library/node:22-bookworm-slim` / `i/o timeout`. Two fixes:

1) Configure a registry mirror once (on Alibaba Cloud ECS use the dedicated address from *Container Registry → Image Accelerator*):

```sh
sudo mkdir -p /etc/docker
sudo tee /etc/docker/daemon.json >/dev/null <<'EOF'
{ "registry-mirrors": ["https://<your-accelerator-id>.mirror.aliyuncs.com"] }
EOF
sudo systemctl daemon-reload && sudo systemctl restart docker
```

2) Leave the daemon alone and override the base images (Compose is parameterised):

```sh
NODE_IMAGE=docker.m.daocloud.io/library/node:22-bookworm-slim \
NGINX_IMAGE=docker.m.daocloud.io/library/nginx:1.27-alpine \
NPM_REGISTRY=https://registry.npmmirror.com \
docker compose up -d --build
```

To make it permanent, copy the bundled template to a root `.env` (Compose reads it automatically and it is gitignored):

```sh
cp .env.docker.example .env
vi .env        # point NODE_IMAGE / NGINX_IMAGE at a mirror; keep NPM_REGISTRY / DEBIAN_MIRROR
docker compose up -d --build
```

Only a root `.env` is picked up automatically by Compose; it holds deployment knobs such as images and ports. Credentials and the API key still live in `server/.env`.

If the mirrors are unreachable as well, pull manually and re-tag so the build can use the local images:

```sh
docker pull docker.m.daocloud.io/library/node:22-bookworm-slim
docker pull docker.m.daocloud.io/library/nginx:1.27-alpine
docker tag docker.m.daocloud.io/library/node:22-bookworm-slim node:22-bookworm-slim
docker tag docker.m.daocloud.io/library/nginx:1.27-alpine nginx:1.27-alpine
```

`NPM_REGISTRY` switches the pnpm registry, which makes dependency installation much faster in mainland China. If the better-sqlite3 prebuild cannot be downloaded either (it comes from GitHub), the image already ships python3/make/g++ so it falls back to compiling from source.

That toolchain step pulls the Debian package index from the upstream mirror, which often takes 200s+ from mainland China; set `DEBIAN_MIRROR=mirrors.aliyun.com` to speed it up. Once the layer succeeds it is cached and rebuilds skip it.

## Backend and real-time multi-device sync

With the backend enabled (details in [server/README.md](server/README.md)):

- **Single personal account** — one username/password pair from `AUTH_USERNAME` / `AUTH_PASSWORD`; sign-up is not exposed, with lockout after repeated failures, a device list and per-device revocation;
- **Server-side API key** — the key never reaches the browser, which only holds a revocable session;
- **Real-time multi-device sync** — conversations and attachments live in SQLite (one row per message); opening a conversation establishes an SSE stream (`GET /api/chats/:id/events?since=N`) so replies generated on another device stream live in real time, and concurrent edits are merged per message;
- **Public share links** — "Share" first asks which messages to include (all selected by default, so sensitive ones can be unchecked), then mints a read-only link (`GET /api/shares/:token`, no sign-in required) that serves a snapshot of the chat; the same chat keeps one stable token, deleting the chat revokes it, and links can be reviewed or revoked in Settings → Data;
- **Streaming proxy** — SSE is forwarded frame by frame, together with attachment uploads and speech endpoints.

Visitors who are not signed in can still chat: each IP gets `GUEST_DAILY_MESSAGES` messages per day (10 by default), counted in SQLite.
Press "Sign in" in the sidebar to use the account from `server/.env` (there is no sign-up), which also unlocks server-side
history, multi-device sync and every proxied endpoint. Guest conversations live in the local browser only. Once signed in,
Settings gains an Account section (sign out other devices, sign out) and hides the per-user API key field. To change the
password, edit `AUTH_PASSWORD` and restart the server.

See [docs/multi-device-sync.md](docs/multi-device-sync.md) for the sync design and
[docs/sqlite-concurrency.md](docs/sqlite-concurrency.md) for the capacity analysis.

## Features

- Multiple conversations with automatic titles, renaming, pinning, and deletion; multi-select to pin or delete in batches; edit prompts, regenerate replies, and switch between message branches.
- Chat sharing: press "Share" next to the chat title (or "More → Share" in the sidebar), pick the messages to include (all selected by default), then "Create share link" and confirm the sensitive-content notice: a read-only link at `https://your-domain/s/<token>` is created and copied. It opens without sign-in, is labelled "Shared conversation" with an AI-generated-content warning, and ends with a "Keep chatting" button. Sharing the same chat again keeps the link and refreshes its content; deleting the chat or revoking the link in Settings → Data invalidates it immediately. In static deployments it falls back to copying the chat as Markdown.
- Visitors who are not signed in get a fixed number of free messages per day (10 by default, per IP, configurable via `server/.env`); the sidebar shows how many are left today.
- Search across the titles and messages of every conversation from the sidebar, with an animated collapse/expand; the collapsed sidebar keeps the logo, and the conversation list scrollbar stays hidden until you scroll.
- Streaming replies, deep thinking, smart search, link reading, and source citations; stop generation or continue eligible replies.
- Upload, paste, or drag and drop attachments; use voice input and read replies aloud. A live audio spectrum appears in the first row of the input area while recording on mobile.
- Markdown, syntax highlighting, KaTeX math, and Mermaid diagrams.
- Simplified Chinese and English, light and dark themes, mobile layouts, location settings, and chat history import and export.

## Data and privacy

- **Static mode** — the API key and settings live in localStorage; conversations and original attachments live in IndexedDB, isolated by browser profile and site origin. Clearing site data clears the chats, and this repository never holds your conversations.
- **Backend mode** — conversations and attachments move to your own server's SQLite, so every device signed into the same account sees the same history; the browser only caches the current page state.
- In both modes, sending messages, uploading attachments, and using speech features sends the relevant content to the configured API service (DeepSeek's official API by default).
- This repository contains **no API key, password or server address**: `server/.env`, `server/data/` and `dist/` are excluded by `.gitignore` — never commit them.

History import and export in Settings use ZIP archives. After confirmation and successful validation, importing replaces all local conversations and attachments. Exports include conversations and locally available original images, but exclude API keys, settings, and original non-image attachments. See the [history import/export documentation (Chinese)](src/services/chat/history/README.md) for the archive format and preservation details.

Settings → Data → Delete all chats clears all local conversations, original attachments, and unsent drafts after confirmation. It stops ongoing replies and returns to a new chat. Your API key and settings are preserved; files already uploaded to the API service are not deleted.

## Development

| Command             | Description                                                |
| ------------------- | ---------------------------------------------------------- |
| `pnpm dev:static`   | Frontend dev server in standalone static mode (no backend)  |
| `pnpm dev`          | Start both backend and frontend dev servers together        |
| `pnpm dev:web`      | Start frontend dev server only (proxies `/api` to backend)  |
| `pnpm dev:server`   | Start backend dev server only                               |
| `pnpm build:static` | Build the standalone static site into `dist/`               |
| `pnpm build`        | Build frontend into `dist/` (same-origin backend mode)      |
| `pnpm build:server` | Build the backend server                                    |
| `pnpm test:server`  | Run backend API and SSE real-time push tests                |
| `pnpm type`         | Run TypeScript type checks for both frontend and backend    |
| `pnpm lint`         | Lint with oxlint                                            |
| `pnpm format`       | Format with oxfmt                                           |

[rspack.config.ts](rspack.config.ts) connects to the backend via same-origin `/api` by default (`BACKEND_ORIGIN=/`, proxying `/api` to `API_PROXY_TARGET`, default `http://127.0.0.1:8787`, during development). Use `createConfig({ apiOrigin, backendOrigin, apiProxyTarget, devServer })` to customize the API origin, backend origin, and dev proxy; pass `BACKEND_ORIGIN=none` for the standalone static build.

Chat uses `deepseek-flash` by default through Anthropic-compatible Messages / Files APIs. Speech features use ASR / TTS endpoints. Requests include extensions for search, link reading, titles, and `latest_reminder`, so the configured service must support the corresponding capabilities. Supported attachment formats are determined by server-side validation.

```text
src/
  app/                 Application layout, themes, and global styles
  components/          Chat, settings, Markdown, and other UI components
  i18n/                English and Chinese translations
  services/
    api/               API requests, SSE, and protocol types
    auth/              Login state, session token, and account requests
    chat/              Conversations, message branches, storage, and history import/export
    markdown/          Markdown parsing, syntax highlighting, and diagrams
    speech/            Audio recording and read-aloud playback
  utils/               Shared utilities
server/                Optional backend: Fastify + SQLite for sign-in, sync, sharing and proxying
docker/                nginx reverse-proxy configs (same-origin gateway / host HTTPS example)
docs/                  Notes on multi-device sync and SQLite concurrency
```

## Contributing

Issues and pull requests are welcome — please read [CONTRIBUTING.md](CONTRIBUTING.md) and [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) first.
Report security problems privately as described in [SECURITY.md](SECURITY.md), never in a public issue.

## Disclaimer

- This project only ships the client and a self-hosted proxy; it comes with **no API quota**. Usage of the DeepSeek API is billed to you and subject to its [terms of service](https://platform.deepseek.com/);
- Model output can be wrong; verify it yourself and do not treat it as professional advice;
- When you self-host, you are responsible for legal compliance in your jurisdiction, including content rules, ICP filing and data-retention requirements.

## Credits

- UI, interactions and protocol handling come from [deepseek-ai/chat-demo](https://github.com/deepseek-ai/chat-demo) (MIT, Copyright (c) DeepSeek);
- This fork is maintained by [AidenX0704](https://github.com/AidenX0704) and adds the optional backend (sign-in, multi-device sync, sharing, guest quota, spreadsheet parsing), the Docker deployment and these docs;
- Key third-party libraries: React, Rspack, Zustand, Fastify, better-sqlite3, KaTeX, Mermaid, PrismJS — each under its own license.

## License

[MIT](LICENSE). The build copies the license to `dist/LICENSE`; include it when distributing the app. Third-party dependencies are subject to their own licenses.
