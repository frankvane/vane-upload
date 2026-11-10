# syntax=docker/dockerfile:1
# vane-upload server 生产镜像（VU-57）。
# 构建上下文是仓库根目录（npm workspaces 需要根 package-lock.json）。
#
# 基础镜像用 Debian slim 而**不是** alpine：`better-sqlite3` 只发布 glibc 的预编译
# 二进制，在 musl（alpine）上会回退到 node-gyp 源码编译，而 alpine 基础镜像里没有
# python3 / make / g++，`npm ci` 会直接失败（CI 的 Container image 步骤即此原因）。
# slim 自带 glibc，预编译包可直接解包，构建也更快。
#
# Node 版本与 .nvmrc / engines 对齐（>=22.8.0）。
FROM node:22-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json ./server/
# 保险：万一预编译二进制取不到（架构/网络），还有本地编译路径。工具链只存在于
# deps 阶段，不进最终镜像；预编译可用时这几步不会被用到。
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
RUN npm ci --omit=dev

FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    AUTH_MODE=secure \
    SHUTDOWN_TIMEOUT_MS=15000

COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json ./
COPY server ./server

# 三个状态目录必须挂持久化卷；先建好并交给非 root 用户。
RUN mkdir -p /app/server/data /app/server/tmp/upload /app/server/uploads \
    && chown -R node:node /app/server
USER node
EXPOSE 3000
VOLUME ["/app/server/data", "/app/server/tmp/upload", "/app/server/uploads"]

# 队列持续失败时 /api/health 会返回 degraded，编排系统可据此摘流量。
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>r.text().then(t=>process.exit(r.ok&&!t.includes('degraded')?0:1))).catch(()=>process.exit(1))"

# 必须用 exec form：PID 1 是 node 本身才能收到 SIGTERM，
# 触发 VU-27 的 graceful shutdown（flush 分片状态 + checkpoint WAL）。
CMD ["node", "server/src/index.js"]
