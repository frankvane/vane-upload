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
| `AUTH_MODE` | `secure` | `demo` 关闭鉴权；其余值 fail-closed |
| `FILE_AUTH_TOKEN` | 空 | Bearer 白名单，逗号分隔 |
| `FILE_AUTH_COOKIE` | 空 | 需要校验的 Cookie 名 |
| `FILE_AUTH_COOKIE_TOKENS` | 空 | Cookie 值白名单，逗号分隔 |
| `CORS_ORIGIN` | 空 | 具体域名白名单，逗号分隔；`*` 仅兼容告警 |
| `RATE_LIMIT_ENABLED` | 开启 | 设为 `false` 关闭限流 |
| `RATE_LIMIT_MAX` | `300` | 每分钟每 IP 请求上限 |
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
| `CHUNK_STATE_FLUSH_INTERVAL_MS` / `CHUNK_STATE_MAX_PENDING` | 内部默认 | 分片状态异步落库参数 |

## 测试

```bash
npm test
```

覆盖上传契约、分片状态、合并校验、配额、鉴权、租户隔离、路径安全等。
