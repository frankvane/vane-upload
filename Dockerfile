# syntax=docker/dockerfile:1
# vane-upload server 生产镜像（VU-57）。
# 构建上下文是仓库根目录（npm workspaces 需要根 package-lock.json）。
FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json ./server/
RUN npm ci --omit=dev

FROM node:20-alpine AS runtime
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
