# chat-web 镜像：前端静态站点（nginx）+ 可选后端服务（Fastify / SQLite）
#
# 两个构建目标，docker-compose.yml 各取其一：
#   target=web     nginx 托管 dist/，并把 /api 反代给后端
#   target=server  Node 运行 Fastify，数据落在 /data 卷
#
# 只构建前端：docker build --target web -t chat-web-web .
# 本地部署：  docker compose up -d --build

ARG NODE_IMAGE=node:22-bookworm-slim
ARG NGINX_IMAGE=nginx:1.27-alpine

# ---- 构建基础层：Node + pnpm ----
FROM ${NODE_IMAGE} AS node-base
# pnpm 锁在 9.x：pnpm 10 默认阻止依赖执行安装脚本，better-sqlite3 会装不到原生二进制
ARG PNPM_VERSION=9.15.9
# 可选 npm 镜像源：国内网络可传 --build-arg NPM_REGISTRY=https://registry.npmmirror.com
ARG NPM_REGISTRY=
ENV CI=true \
    PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH
RUN npm install -g pnpm@${PNPM_VERSION} --no-fund --no-audit \
 && if [ -n "${NPM_REGISTRY}" ]; then pnpm config set registry "${NPM_REGISTRY}"; fi

# ---- 带编译工具链的构建基础层 ----
# better-sqlite3 优先用预编译包；拿不到预编译时（架构不支持、GitHub 不可达）
# 会退回源码编译，这时需要 python3 / make / g++。工具链只留在构建层，不进运行镜像。
FROM node-base AS node-build
# 可选 Debian 镜像站（境内建议 mirrors.aliyun.com），只在装工具链这一步生效
ARG DEBIAN_MIRROR=
# apt 索引与包缓存挂到 BuildKit 缓存：改了上层源码后重建不再重新下载
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
    if [ -n "${DEBIAN_MIRROR}" ]; then \
      sed -i "s|deb.debian.org|${DEBIAN_MIRROR}|g" /etc/apt/sources.list.d/debian.sources /etc/apt/sources.list 2>/dev/null || true; \
    fi \
 && apt-get -o Acquire::Retries=3 update \
 && apt-get install -y --no-install-recommends python3 make g++

# ---- 前端构建：产出 dist/ ----
FROM node-base AS web-build
WORKDIR /app
# 先只拷依赖清单，源码改动时复用这一层缓存
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json rspack.config.ts ./
COPY src ./src
COPY LICENSE ./
# 默认同源接入后端（BACKEND_ORIGIN=/），页面里所有请求都走 /api
RUN pnpm build

# ---- 后端生产依赖 ----
FROM node-build AS server-deps
WORKDIR /app/server
COPY server/package.json server/pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod

# ---- 后端构建：tsc 编译到 dist/ ----
FROM node-build AS server-build
WORKDIR /app/server
COPY server/package.json server/pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY server/tsconfig.json server/tsconfig.build.json ./
COPY server/src ./src
RUN pnpm build

# ---- 后端运行时 ----
FROM ${NODE_IMAGE} AS server
LABEL org.opencontainers.image.title="chat-web-server" \
      org.opencontainers.image.description="chat-web 后端：登录、会话同步与 DeepSeek 代理"
# DATABASE_PATH 里的文件名是历史遗留，保持兼容：老部署升级后仍能读到原来的数据库
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787 \
    DATABASE_PATH=/data/chat-personal.sqlite \
    DATA_DIR=/data/files
WORKDIR /app
# 配置全部走环境变量（compose 注入），镜像里不放 .env，避免把口令带进镜像层
COPY --from=server-deps /app/server/node_modules ./node_modules
COPY --from=server-build /app/server/dist ./dist
COPY server/package.json ./package.json
# 命名卷首次创建时继承镜像内目录的属主，node 用户因此可写
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 8787
# 容器自检：直接打本地健康接口，不依赖镜像里有没有 curl
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/api/health').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# 只跑一个进程：SQLite 单写者最省心；多实例见 docs/sqlite-concurrency.md
CMD ["node", "dist/main.js"]

# ---- 前端运行时（默认目标）----
FROM ${NGINX_IMAGE} AS web
LABEL org.opencontainers.image.title="chat-web-web" \
      org.opencontainers.image.description="chat-web 前端静态站点与 /api 反向代理"
# 去掉默认站点，换成项目自己的同源配置
RUN rm -f /etc/nginx/conf.d/default.conf
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=web-build /app/dist /usr/share/nginx/html
EXPOSE 80
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -q --spider http://127.0.0.1/healthz || exit 1
