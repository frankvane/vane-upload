# vane-upload

独立的上传项目：只负责文件上传，不包含任何下载能力。从 `E:\react-upload-indexeddb` 中迁移上传链路与后端上传接口而来。

## 范围

包含：

- 上传组件 `ZustandFileUpload`（文件选择、校验、队列、暂停/继续、重试、删除）
- 分片上传与断点续传（服务端分片状态查询 + 秒传预检）
- 文件/分片并发控制、网络自适应参数
- 上传进度与状态管理（Zustand store）
- IndexedDB 暂存与刷新后中断任务恢复（`localforage`）
- Web Worker：文件哈希预处理（`filePrepareWorker`）、分片上传（`uploadWorker`）
- 内置 UI 套件与上传相关样式
- 后端上传接口：秒传预检、分片状态、分片上传、合并

不包含：

- 下载页面、组件、路由、hooks、下载 Worker
- 后端列表/下载/缩略图接口
- 下载相关类型、测试、样式、文档

## 目录结构

```
vane-upload/
├── index.html
├── vite.config.ts
├── tsconfig*.json
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

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/file/instant` | 秒传预检 + 已上传分片校验（请求体含 `file_id`、`md5`、`name`、`size`、`chunk_md5s`、`chunk_size`） |
| GET | `/api/file/status` | 查询某分片键已成功上传的分片索引（`file_id`、`md5`） |
| POST | `/api/file/upload` | 上传单个分片，`multipart/form-data` 字段 `file_id`、`index`、`chunk_md5`、`chunk` |
| POST | `/api/file/merge` | 合并分片并落库，字段 `file_id`、`md5`、`name`、`size`、`total` |
| GET | `/api/health` | 健康检查 |

鉴权：默认 `AUTH_MODE=secure`（fail-closed），需配置 `FILE_AUTH_TOKEN` 或 Cookie 白名单；仅本地演示/测试可设 `AUTH_MODE=demo`。详见 [server/README.md](server/README.md)。

## 断点续传与 IndexedDB

- 上传队列快照写入 `localforage`（默认 IndexedDB 存储），按 `instanceId` 隔离多实例。
- 页面刷新后，未完成记录会恢复为待上传；若运行时 `File` 引用已丢失，会标记为需重新选择文件。
- 分片键为 `${md5}_${size}_${chunkSize}`，网络自适应改变分片大小时新旧分片天然隔离。

## 测试与校验

```bash
npm test           # 前端单元测试（vitest）
npm run test:server # 后端接口测试（node:test + supertest）
npm run typecheck  # TypeScript 类型检查
npm run lint       # ESLint
```

## 调试日志

上传链路内部使用 `src/shared/debugLogger.ts` 统一输出：

- 默认静默，只透出真实错误；
- 需要排查时调用 `configureDebug({ silent: false })` 打开全部日志；
- `getDebugLog()` / `clearDebugLog()` 用于取用和清空环形缓冲。

组件 `debug` prop 可额外开启 Worker 分片级日志（200ms 节流），不影响上传逻辑。
