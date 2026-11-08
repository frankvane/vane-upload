# vane-upload

独立的上传项目：只负责文件上传。

## 范围

- 上传组件 `ZustandFileUpload`（文件选择、校验、队列、暂停/继续、重试、删除）
- 分片上传与断点续传（服务端分片状态查询 + 秒传预检）
- 文件/分片并发控制、网络自适应参数
- 上传进度与状态管理（Zustand store）
- IndexedDB 暂存与刷新后中断任务恢复（`localforage` 存元数据，`react-upload-chunks` 存未确认分片，刷新后零点击续传）
- Web Worker：文件哈希预处理（`filePrepareWorker`）、分片上传（`uploadWorker`）
- 内置 UI 套件与上传相关样式
- 后端上传接口：秒传预检、分片状态、分片上传、合并

## 目录结构

```
vane-upload/
├── index.html
├── vite.config.ts               # demo 应用 / Vitest 配置
├── vite.lib.config.ts           # 组件库构建配置（VU-24）
├── tsconfig*.json               # 含 tsconfig.lib.json（声明文件产出）
├── eslint.config.js
├── package.json                 # 根工程 + workspaces
├── src/
│   ├── main.tsx
│   ├── App.tsx                  # 上传演示页
│   ├── index.ts                 # 上传链路的公共导出
│   ├── config/api.ts            # 上传接口路径
│   ├── components/ZustandFileUpload/
│   │   ├── index.tsx            # 组件入口
│   │   ├── components/          # 表格、工具栏、批次信息、存储用量
│   │   ├── context/             # 上传引擎 / 配置上下文
│   │   ├── hooks/               # 编排、文件处理、网络检测、生命周期
│   │   ├── services/            # 存储、编排、清理策略、Worker 桥接
│   │   ├── store/               # Zustand 上传状态
│   │   ├── types/               # 上传类型与 Worker 协议
│   │   └── worker/              # 哈希预处理、分片上传
│   ├── shared/                  # 上传链路共用工具
│   ├── ui/                      # 内置极简 UI 套件（含 ui.css）
│   └── test/setup.ts            # vitest 环境准备
└── server/
    ├── package.json
    ├── src/
    │   ├── index.js             # 服务启动
    │   ├── app.js               # Express 应用与鉴权
    │   ├── controllers/uploadController.js
    │   ├── routes/fileRoutes.js # 仅上传路由
    │   ├── models/              # File / FileChunk
    │   ├── services/chunkStateQueue.js
    │   ├── middleware/          # 鉴权、分片上传
    │   ├── config/              # 路径与 SQLite
    │   └── utils/               # 哈希、路径安全、错误脱敏
    └── tests/                   # 上传接口与安全测试
```

## 安装

需要 Node.js >= 20。根工程使用 npm workspaces，一次安装前后端依赖：

```bash
npm install
```

## 启动

后端（默认 `http://localhost:3000`）：

```bash
npm run dev:server
# 等价于 npm run dev -w server
```

本地演示使用 `AUTH_MODE=demo` 关闭鉴权：

```powershell
$env:AUTH_MODE="demo"; npm run dev:server
```

前端（默认 `http://localhost:5173`，`/api` 代理到 `http://localhost:3000`）：

```bash
npm run dev
```

构建与预览：

```bash
npm run build
npm run preview
```

## 作为组件库使用

`npm run build` 依次产出演示应用（`dist/`）与可发布的库产物（`dist/lib/`），也可单独执行：

```bash
npm run build:demo   # vite build：dist/index.html + assets，两个 Worker 为独立 asset
npm run build:lib    # vite build --config vite.lib.config.ts + tsc -p tsconfig.lib.json
```

`dist/lib/` 内容：

| 文件 | 用途 |
| ---- | ---- |
| `index.js` / `index.cjs` | ESM / CJS 入口，由 `package.json` 的 `exports` 指向 |
| `index.d.ts` 及子模块声明 | TypeScript 类型（`tsc --emitDeclarationOnly` 产出，无额外依赖） |
| `style.css` | 组件样式，需消费方显式引入 |

消费示例（React 19 项目）：

```tsx
import { ZustandFileUpload, type UploadFile } from "vane-upload";
import "vane-upload/style.css";
```

- `react` / `react-dom` / `zustand` / `localforage` / `spark-md5` 在库构建中为 external，由消费方提供，不会重复打包。
- 库产物中的两个 Web Worker 以内联 Blob 形式自包含，消费方无需配置额外资产路径；演示应用构建则拆为独立 Worker asset，便于缓存与并行加载。

## 前端配置

`src/config/api.ts` 读取 `VITE_API_BASE_URL`（可选），未设置时使用同源相对路径。组件 props 也可覆盖：

```tsx
<ZustandFileUpload
  baseURL=""
  uploadApi="/api/file/upload"
  checkApi="/api/file/instant"
  mergeApi="/api/file/merge"
/>
```

开发代理目标可用 `VITE_DEV_API_PROXY_TARGET` 覆盖，默认 `http://localhost:3000`。

## 后端接口

统一前缀 `/api/file`，响应格式 `{ code, message, data }`。

| 方法 | 路径                | 说明                                                                                               |
| ---- | ------------------- | -------------------------------------------------------------------------------------------------- |
| POST | `/api/file/instant` | 秒传预检 + 已上传分片校验（请求体含 `file_id`、`md5`、`name`、`size`、`chunk_md5s`、`chunk_size`） |
| GET  | `/api/file/status`  | 查询某分片键已成功上传的分片索引（`file_id`、`md5`）                                               |
| POST | `/api/file/upload`  | 上传单个分片，`multipart/form-data` 字段 `file_id`、`index`、`chunk_md5`、`chunk`                  |
| POST | `/api/file/merge`   | 合并分片并落库，字段 `file_id`、`md5`、`name`、`size`、`total`                                     |
| GET  | `/api/health`       | 健康检查                                                                                           |

鉴权：默认 `AUTH_MODE=secure`（fail-closed），需配置 `FILE_AUTH_TOKEN` 或 Cookie 白名单；仅本地演示/测试可设 `AUTH_MODE=demo`。详见 [server/README.md](server/README.md)。

## 断点续传与 IndexedDB

- 上传队列快照写入 `localforage`（默认 IndexedDB 存储），按 `instanceId` 隔离多实例。
- 未确认成功的分片字节写入独立的 `react-upload-chunks` IndexedDB：每片上传成功即删除对应缓存，占用随进度下降；分片元信息最后写入作为「缓存就绪」提交标记。
- 页面刷新后，未完成记录恢复为待上传；若分片缓存就绪则**零点击自动续传**（沿用持久化的 hash / chunkSize / chunkCount），不再要求重新选择文件。
- 缓存不可用时降级：单文件超过 `chunkCacheMaxFileSize`（默认 512 MB）、存储配额不足、隐私模式或 IndexedDB 写入失败时，记录标记为 `awaitingReselect` 并明确提示「需重新选择文件」，不会伪装成正在续传。
- 清理时机：上传完成、用户取消、删除记录、合并失败且不再重试时，同步清除该文件的分片缓存。
- 分片键为 `${md5}_${size}_${chunkSize}`，网络自适应改变分片大小时新旧分片天然隔离。

## 测试与校验

```bash
npm test           # 前端单元测试（vitest）
npm run test:server # 后端接口测试（node:test + supertest）
npm run typecheck  # TypeScript 类型检查
npm run lint       # ESLint
npm run ci         # 一条命令跑完上述全部 + build（demo + lib）
```

GitHub Actions 的 `.github/workflows/ci.yml` 直接调用 `npm run ci`，并额外执行一次
`docker build` 冒烟，保证 CI 与本地门禁不会漂移。覆盖率阈值（`VU-62`）尚未接入，
需要单独引入 `@vitest/coverage-v8` 后再补。

## 容器与部署基线

```bash
docker build -t vane-upload-server .
docker run --rm -p 3000:3000 \
  -e FILE_AUTH_TOKEN='replace-with-a-long-random-token' \
  -e TRUST_PROXY_HOPS=1 \
  -v "$(pwd)/.data:/app/server/data" \
  -v "$(pwd)/.tmp:/app/server/tmp/upload" \
  -v "$(pwd)/.uploads:/app/server/uploads" \
  vane-upload-server
```

- 镜像以非 root 用户运行，`CMD` 用 exec form 让 PID 1 是 node，能收到 `SIGTERM`
  并走优雅停机（flush 分片状态 + checkpoint WAL）。
- `HEALTHCHECK` 同时检查 `/api/health` 的状态码与 `degraded` 标记，落库队列
  持续失败时容器会被判定不健康。
- 生产必须注入 `FILE_AUTH_TOKEN`（或替换鉴权中间件）；`AUTH_MODE=secure` 默认
  fail-closed，缺凭据时所有 `/api/file` 请求一律 401。
- 反代按真实跳数设置 `TRUST_PROXY_HOPS`，不要设 `true`；Cookie 鉴权还需由部署方
  配置 `SameSite` / `Secure` / CSRF。日志轮转与 stdout 采集由部署方负责。
- 更完整的环境变量清单见 `server/.env.example`，后端部署说明见 `server/README.md`。

## 调试日志

上传链路内部使用 `src/shared/debugLogger.ts` 统一输出：

- 默认静默，只透出真实错误；
- 需要排查时调用 `configureDebug({ silent: false })` 打开全部日志；
- `getDebugLog()` / `clearDebugLog()` 用于取用和清空环形缓冲。

组件 `debug` prop 可额外开启 Worker 分片级日志（200ms 节流），不影响上传逻辑。
