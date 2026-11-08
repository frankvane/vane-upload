# vane-upload server

仅提供上传能力的后端服务。

## 技术栈

- Node.js + Express
- Sequelize
- SQLite（通过 `better-sqlite3` 适配器接入）

## 启动

```bash
npm install
npm run dev
```

默认监听 `http://localhost:3000`。本地演示需设置 `AUTH_MODE=demo` 关闭鉴权。

配置样例见 `server/.env.example`。**本仓库不自动加载 `.env`**，请由进程管理器 / 容器注入；
所有环境变量只在 `server/src/config/index.js` 中读取，生产启动时由
`validateStartupConfig()` 做 fail-fast 自检（缺凭据、目录不可写、CORS 通配、容量配置倒挂）。

## 接口

所有接口挂在 `/api/file/*`：

- `POST /instant`：秒传预检与分片校验
- `GET /status`：已上传分片索引
- `POST /upload`：上传单个分片
- `POST /merge`：合并分片
- `GET /api/health`：健康检查

## 存储目录

- `server/data`：SQLite 数据库（`DB_STORAGE` 可覆盖）
- `server/tmp/upload`：分片暂存（`SERVER_TMP_UPLOAD_DIR` 可覆盖）
- `server/uploads`：合并后的文件（`SERVER_UPLOADS_DIR` 可覆盖）

## 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `3000` | 监听端口 |
| `NODE_ENV` | `development` | `test` / `development` 保留原始错误文案；生产一律脱敏 |
| `LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error` |
| `SHUTDOWN_TIMEOUT_MS` | `15000` | 优雅停机强制退出兜底 |
| `JSON_BODY_LIMIT_MB` | `8` | 已鉴权 `/api/file` 的 JSON 请求体上限（VU-09） |
| `ALLOWED_MIME_TYPES` | 空 | 逗号分隔的 MIME 白名单；留空走危险类型黑名单（VU-33） |
| `MERGE_WAIT_TIMEOUT_MS` | `30000` | 同键合并锁等待超时（VU-08） |
| `MERGE_MAX_WAITERS` | `64` | 同键合并等待者上限，超出返回 429 |
| `DEMO_USER_ID` | `test` | `AUTH_MODE=demo` 时映射到的用户身份 |
| `SQL_LOG` | `0` | 设为 `1` 打印 Sequelize SQL |
| `AUTH_MODE` | `secure` | `demo` 关闭鉴权；其余值 fail-closed |
| `FILE_AUTH_TOKEN` | 空 | Bearer 白名单，逗号分隔 |
| `FILE_AUTH_COOKIE` | 空 | 需要校验的 Cookie 名 |
| `FILE_AUTH_COOKIE_TOKENS` | 空 | Cookie 值白名单，逗号分隔 |
| `CORS_ORIGIN` | 空 | 具体域名白名单，逗号分隔；`*` 仅兼容告警 |
| `RATE_LIMIT_ENABLED` | 开启 | 设为 `false` 关闭限流 |
| `RATE_LIMIT_MAX` | `300` | 每分钟每 IP 请求上限；`0` = 不挂载限流器 |
| `TRUST_PROXY_HOPS` | 未设置（不信任代理） | 反向代理跳数，整数。设置后 `req.ip` 取可信 `X-Forwarded-For` 最右一跳，限流按真实源 IP 分桶；**禁止**设为 `true` 或留空后依赖伪造 XFF |
| `MAX_UPLOAD_SIZE_MB` | `5120` | 单文件上限 |
| `MAX_CHUNKS` | `100000` | 单文件分片上限 |
| `MAX_TOTAL_UPLOAD_SIZE_MB` | `20480` | 进程级总容量上限 |
| `MAX_TOTAL_CHUNKS` | `200000` | 进程级总分片上限 |
| `MAX_USER_UPLOAD_SIZE_MB` | `10240` | 单用户累计容量上限 |
| `MAX_USER_CHUNKS` | `100000` | 单用户累计分片上限 |
| `CHUNK_MAX_SIZE_MB` | `20` | 单个分片请求体上限 |
| `TMP_TTL_HOURS` | `24` | 孤儿分片保留时长 |
| `JANITOR_INTERVAL_HOURS` | `6` | 孤儿分片清理间隔 |
| `SERVER_DATA_DIR` / `SERVER_TMP_UPLOAD_DIR` / `SERVER_UPLOADS_DIR` | 见上 | 运行目录覆盖 |
| `DB_STORAGE` | `server/data/indexeddb-upload.sqlite` | SQLite 文件路径 |
| `CHUNK_STATE_FLUSH_INTERVAL_MS` / `CHUNK_STATE_MAX_PENDING` / `CHUNK_STATE_BATCH_SIZE` | `180` / `120` / `40` | 分片状态异步落库参数 |

## 安全基线

- **请求体解析在鉴权之后**：匿名请求直接 401，不会先消耗 JSON 解析；`chunk_md5s`
  的元素类型与长度也会被校验（VU-09）。
- **文件类型策略**：合并落盘前拒绝危险扩展名（`html/svg/exe/js/php/...`）与危险 MIME；
  配置 `ALLOWED_MIME_TYPES` 后切换为严格白名单。校验发生在 staging 阶段，
  415 时 `uploads/` 零残留（VU-33）。
- **符号链接防护**：分片 / staging 写入前用 `lstat` 拒绝非普通文件，实际写入走
  `O_NOFOLLOW`（Windows 退化为 fstat 校验）；`resolveInsideBase` 补 realpath 校验；
  janitor 用 `lstat` 清理过期软链而不跟随目标（VU-34）。
- **下载头**：若部署侧把 `UPLOADS_DIR` 映射为静态目录，务必统一返回
  `Content-Disposition: attachment` 与 `X-Content-Type-Options: nosniff`。

缩略图能力未启用：项目未声明 `sharp` 依赖，也不引入新的重型依赖；
`files.thumbnail_path` 保留列但恒为 `null`（VU-14）。

## 日志、部署与可观测性

- 所有日志经 `src/utils/logger.js` 分级输出（`LOG_LEVEL` 控制），并统一脱敏：
  Bearer / Cookie、`file_id=`/`md5=` 等 query 值、绝对路径都会被替换为 `***` /
  `[path]`。请求日志只记路径模板，不记 query（VU-38）。
- **日志轮转与 stdout 采集由部署方负责**（例如容器日志驱动 + logrotate / 日志平台），
  本项目不内置文件轮转，也不引入 winston / pino。
- 部署基线：① 反代按真实跳数设 `TRUST_PROXY_HOPS`，不要设 `true`；
  ② Cookie 鉴权需由部署方设置 `SameSite` / `Secure` / CSRF 防护；
  ③ `server/data`、`server/tmp/upload`、`server/uploads` 挂持久化卷；
  ④ `PID 1` 必须能收到 `SIGTERM`。

## 停机语义

`SIGTERM` / `SIGINT` 会触发优雅停机：停止接收新连接 → 停止 janitor →
把内存中未刷盘的分片状态写入 SQLite → 关闭数据库连接 → 退出。
超过 15 秒未完成会强制退出并返回非 0，便于编排系统识别异常。
容器部署必须让 `PID 1` 收到 `SIGTERM`（不要用 `shell form` 启动）。

## 测试

```bash
npm test
```

覆盖上传契约、分片状态、合并校验、配额、鉴权、租户隔离、路径安全等。
