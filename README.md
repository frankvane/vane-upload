# vane-upload

React 分片上传组件。一次选文件，自动完成 **哈希 → 秒传预检 → 分片并发上传 → 合并**，
自带完整 UI（工具栏 + 文件表格 + 批次进度 + 存储统计），开箱可用。

```tsx
import { ZustandFileUpload } from "vane-upload";
import "vane-upload/style.css";

<ZustandFileUpload uploadApi="/api/file/upload" />
```

## 特性

- **分片上传**：默认 1MB 分片，文件级 / 分片级并发可调，失败自动重试（默认 3 次）
- **秒传**：同内容文件服务端已存在时直接命中，不再传输字节
- **断点续传**：暂停 / 取消 / 刷新页面后均可从已上传分片继续，无需重新选文件
- **完整 UI**：上传 / 暂停 / 继续 / 取消 / 重试 / 删除、批次详情、存储统计、网络自适应徽标
- **受控回调**：开始、进度（含速率与剩余时间）、单文件完成、单文件失败、整批完成
- **可定制**：接口路径、并发与重试、大小与数量限制、可见列、自定义校验、鉴权头

---

## 安装

```bash
npm i vane-upload
```

`react` / `react-dom`（`^19.3.1`）为 peer 依赖，需宿主项目自行安装；
`zustand` / `localforage` / `spark-md5` 随包安装，无需额外处理。

## 快速开始

```tsx
import { useState } from "react";
import { ZustandFileUpload, type UploadFile } from "vane-upload";
import "vane-upload/style.css";

// 注意：数组和回调请定义在组件外或用 useCallback/useMemo 固定引用，
// 否则每次渲染都会重建内部配置，影响性能。
const ALLOWED_TYPES: string[] = [];

export default function UploadPage() {
  const [done, setDone] = useState<UploadFile[]>([]);

  return (
    <ZustandFileUpload
      uploadApi="/api/file/upload"
      checkApi="/api/file/instant"
      mergeApi="/api/file/merge"
      chunkSize={1024 * 1024}
      maxFileSize={100 * 1024 * 1024}
      maxFiles={10}
      allowedFileTypes={ALLOWED_TYPES}
      autoUpload
      onUploadComplete={(file, success) => {
        if (success) setDone((prev) => [...prev, file]);
      }}
      onBatchComplete={({ success, failed, total }) =>
        console.log(`本批：共 ${total}，成功 ${success}，失败 ${failed}`)
      }
    />
  );
}
```

> 组件只负责上传，不含下载功能。后端需实现下方 5 个业务接口（见「后端接口契约」），
> 仓库内 `server/` 提供了一份可直接运行的参考实现。

---

## 属性（Props）

### 接口地址

| 属性 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `baseURL` | `string` | `""` | 接口前缀。空字符串表示同源相对路径；跨域时填 `https://api.example.com` |
| `uploadApi` | `string` | `"/api/file/upload"` | 分片上传接口路径 |
| `checkApi` | `string` | `"/api/file/instant"` | 秒传预检接口路径。续传用的 `/status` 接口按命名约定由它推导（`/instant` → `/status`），自定义路径请保持同一约定 |
| `mergeApi` | `string` | `"/api/file/merge"` | 分片合并接口路径 |

### 上传参数

| 属性 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `chunkSize` | `number` | `1048576`（1MB） | 分片大小（字节）。分片键含该值，调整后新旧分片天然隔离 |
| `fileConcurrency` | `number` | `2` | **同时上传的文件数**（不是总数上限） |
| `chunkConcurrency` | `number` | `2` | 单个文件内**同时上传的分片数** |
| `maxRetries` | `number` | `3` | 单文件失败重试次数 |
| `hashMode` | `"full" \| "sample"` | `"full"` | `full`：全量流式哈希，内存占用与文件大小无关，服务端合并强校验；`sample`：采样哈希，超大文件更快，代价是极低概率采样碰撞 |

### 文件限制

| 属性 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `maxFiles` | `number` | `100` | 列表内**文件总数上限**（已有 + 本次）。超限时**整批拒绝**，提示「最多只能选择 N 个文件（当前已有 M 个）」 |
| `maxFileSize` | `number` | `104857600`（100MB） | 单文件大小上限（字节）。超限文件**单独跳过**，其余文件照常入队 |
| `allowedFileTypes` | `string[]` | `[]`（不限） | 允许的 MIME 类型或扩展名，如 `["image/png", ".pdf"]` |
| `customFileValidator` | `(file: File) => { valid: boolean; message?: string }` | — | 自定义校验。`valid: false` 时该文件不入队，`message` 作为错误提示 |

> 另有内置的**危险扩展名**拦截（40 项：`.html` / `.svg` / `.js` / `.wasm` / `.exe` / `.bat` / `.php` 等，
> 与服务端落盘校验共用同一份清单）与**同文件去重**（hash + size + lastModified + name 全等视为同一条记录），无需配置。

### UI 行为

| 属性 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `uiMode` | `"full" \| "simple"` | `"full"` | `simple` 仅保留「选择文件 + 文件表格」，隐藏上传/清除/批量重试按钮、批次信息、存储统计抽屉与网络徽标 |
| `autoUpload` | `boolean` | `true` | 选完文件立即开始上传；`false` 时文件停在「排队中」，需点「上传文件」 |
| `autoUploadDelay` | `number` | `120` | 自动上传的**合并窗口**（毫秒）：预处理完成后等这么久再开跑，把「连续几次选择」合成一批。传 `0` 表示立即上传（间隔超过窗口的两次选择会变成两批，服务端多一轮 `/merge`）；旧版本是写死的 `500`，需要旧观感就显式传 `500`。手动点「上传文件」不经过该窗口 |
| `autoCleanup` | `boolean` | `true` | 上传完成后自动移除记录 |
| `cleanupDelay` | `number` | `10` | 自动清理延时（秒） |
| `networkDisplayMode` | `"tooltip" \| "direct"` | `"tooltip"` | 网络徽标（如 `4G 1MB \| 2文件 \| 2分片`）的展开方式：悬停提示 / 直接显示 |
| `visibleColumns` | `UploadColumnKey[]` | 全部 | 表格可见列，按数组顺序排列。可选：`index` / `fileName` / `fileSize` / `chunkCount` / `status` / `progress` / `action`。**隐藏 `action` 后将无法在表格内暂停/继续/重试/删除** |
| `instanceId` | `string` | `"default"` | 多实例隔离标识。同页放多个上传组件时传不同值，避免相互串数据 |
| `settingsSource` | `"localStorage" \| "props"` | `"localStorage"` | `localStorage`：用户在界面切换的开关（自动上传/自动清理/延时/显示模式）会被记住并在下次挂载时恢复；`props`：不读取本地保存值，始终以 props 为准（界面切换仍会写入本地，只是不会被读回） |
| `chunkCacheMaxFileSize` | `number` | `Infinity` | 分片缓存上限（字节），仅作保险。默认按浏览器可用空间判定，非「整个文件大小」 |
| `debug` | `boolean` | `false` | 输出 Worker 分片级日志（200ms 节流），仅供排查，不影响上传逻辑 |

### 鉴权

| 属性 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `authToken` | `string` | — | 静态 Token（适合演示，不建议硬编码） |
| `getAuthToken` | `() => string \| undefined \| Promise<...>` | — | 每次请求前动态取 Token（推荐，支持从异步存储/刷新逻辑取值） |
| `getAuthHeaders` | `() => Record<string, string> \| Promise<...>` | — | 完全自定义请求头，**优先级最高**，覆盖上面两者 |
| `authScheme` | `string` | `"Bearer"` | Token 前缀，最终头为 `Authorization: <scheme> <token>` |
| `withCredentials` | `boolean` | `false` | 是否以 `credentials: "include"` 发送（Cookie 鉴权）。开启需服务端返回 `Access-Control-Allow-Credentials: true` |

---

## 事件（回调）

| 回调 | 签名 | 触发时机 |
| --- | --- | --- |
| `onUploadStart` | `(files: UploadFile[]) => void` | 一批上传真正开始时（点「上传文件」或自动上传）。参数为**本次可上传**的记录 |
| `onUploadProgressDetail` | `(file, detail: UploadProgressDetail) => void` | 每个文件进度变化时。**推荐使用**，`detail` 含 `progress` / `uploadedBytes` / `totalBytes` / `speed` / `eta` |
| `onUploadProgress` | `(file, progress: number) => void` | 同上，仅百分比。**已废弃**，新项目请用 `onUploadProgressDetail` |
| `onUploadComplete` | `(file, success: boolean) => void` | 单个文件上传成功时。**「已完成」和「秒传成功」都会触发，`success` 均为 `true`** |
| `onUploadError` | `(file, error: string) => void` | 单个文件进入**终态失败**时（重试耗尽后），`error` 为可直接展示的文案 |
| `onBatchComplete` | `(results: { success; failed; total; skipped? }) => void` | 一批上传结束时（**含存在失败的情况**）。`skipped` 是排队期间被删除、未执行也不计失败的数量（可选，旧代码忽略即可） |

`UploadProgressDetail` 结构：

```ts
interface UploadProgressDetail {
  progress: number;      // 整体百分比 0-100
  uploadedBytes: number; // 已上传字节
  totalBytes: number;    // 文件总字节
  speed: number;         // 瞬时速率（字节/秒）
  eta: number;           // 预计剩余时间（秒），无法估算时为 0
}
```

**以下几点容易踩坑，务必知悉：**

1. **暂停 / 取消 / 删除不会触发任何回调。** 它们只改变行状态，需要感知请订阅进度停止或自行记录操作。
2. **整批「取消上传」（批次详情抽屉里的按钮）不触发 `onBatchComplete`。** 只有跑完的批次才回调。
   单个文件被取消 / 排队期间被删除也一样：前者算「取消」不计入失败，后者计入 `skipped`（不是 `failed`）。
3. **批量重试不触发 `onUploadStart`**，但它引发的成功/失败仍会触发 `onUploadComplete` / `onUploadError`。
4. **内置 message 的覆盖范围**：文件校验失败、网络断开、删除/清空/重试失败会由组件自己弹提示（若你也弹 toast 会重复）；
   而**单个文件上传到终态失败只走 `onUploadError`**，组件不额外弹提示，需要你自行提示用户。

---

## 方法

**当前版本（0.1.0）组件不暴露 ref 命令式 API**（没有 `forwardRef` / `useImperativeHandle`），
所有操作都通过内置 UI 完成。若需要「外部按钮触发上传 / 取消」，目前只能：

- 用 `autoUpload` + 自定义选择文件入口控制时机；
- 或直接把内置工具栏一起用（它已经包含全部操作）。

内置操作清单与可操作性矩阵：

| 操作 | 入口 | 可用条件 | 行为 |
| --- | --- | --- | --- |
| 选择文件 | 工具栏「选择文件」 | 网络在线 | 打开系统文件对话框，支持多选 |
| 上传 | 工具栏「上传文件」 | 有记录且无进行中任务 | 上传全部「排队中 / 待上传」记录 |
| 清除列表 | 工具栏「清除列表」 | 有记录且无进行中任务 | 移除全部记录并清理本地分片缓存 |
| 批量重试 | 工具栏「批量重试 (n)」 | 存在失败记录且无进行中任务 | 重试全部失败记录 |
| 暂停 | 行内「暂停」 | 状态 = 上传中 | 在分片边界安全暂停，保留进度 |
| 继续 | 行内「继续」 | 状态 = 已暂停 | 从断点续传，不重传已成功分片 |
| 取消 | 行内「取消」 | 状态 = 上传中 | 中止传输并保留记录（转为「已暂停」，可「继续」） |
| 重试 | 行内「重试」 | 状态 = 上传失败 | 重试该文件 |
| 删除 | 行内「删除」 | 任意状态 | 移除记录 + 清理服务端分片与本地缓存；**上传中删除会真实中止传输** |
| 整批取消 | 批次详情抽屉「取消上传」 | `uiMode="full"` 且有进行中任务 | 中止整批，在飞行的行统一落定为「已暂停」 |

> 需要真正的命令式 API（如 `ref.current.upload()`）可以提需求，这是一个明确的能力缺口，
> 而不是用法问题。

### 其他导出

```ts
import {
  ZustandFileUpload,     // 组件（同时导出别名 FileUpload）
  UploadStatus,          // 状态枚举
  statusMap,             // 状态 → { text, color } 文案映射
  configureDebug,        // configureDebug({ silent: false }) 打开全量调试日志
  getDebugLog,           // 取环形缓冲日志
  clearDebugLog,         // 清空日志
  resolveAuthHeaders,    // 自行发请求时复用同一套鉴权头解析
  ErrorBoundary,         // 组件内置的顶层错误边界，可单独使用
} from "vane-upload";

import type {
  UploadFile, ZustandFileUploadProps, UploadColumnKey,
  UploadConfig, UploadAuthConfig, BatchInfo, ProcessProgress,
  UploadUIMode, UploadSettingsSource, AlignItem, MessageInstance,
} from "vane-upload";
```

---

## 文件状态

`UploadFile.status` 取值与界面文案：

| 枚举 | 值 | 文案 | 含义 |
| --- | --- | --- | --- |
| `QUEUED` | `queued` | 排队中 | 已入队，等待上传 |
| `QUEUED_FOR_UPLOAD` | `queued-for-upload` | 待上传 | 等待被批次取走 |
| `PREPARING_UPLOAD` | `preparing-upload` | 准备上传 | 正在计算哈希 / 预检分片 |
| `UPLOADING` | `uploading` | 上传中 | 正在传输分片 |
| `PAUSED` | `paused` | 已暂停 | 可点「继续」续传；**不会被「上传文件」自动带上** |
| `DONE` | `done` | 已完成 | 分片合并完成 |
| `INSTANT` | `instant` | 秒传成功 | 服务端已存在同内容文件，未传字节 |
| `ERROR` | `error` | 上传失败 | 终态失败，需显式「重试」 |

`UploadFile` 常用字段：`id` / `fileName` / `fileSize` / `fileType` / `status` / `progress`(0-100)
/ `hash` / `chunkSize` / `chunkCount` / `uploadedChunks` / `errorMessage` / `speed` / `eta`
/ `awaitingReselect`（刷新后缓存缺失，需用户重新选择同一文件）。

**自动上传只会带上 `QUEUED` / `QUEUED_FOR_UPLOAD` / `PREPARING_UPLOAD` / `UPLOADING` 的记录**；
`PAUSED` 与 `ERROR` 需要用户显式操作，避免刷新后被顺带重跑。

---

## 自定义校验示例

```tsx
const validator = (file: File) => {
  if (file.name.includes("test")) {
    return { valid: false, message: "文件名包含 test 时不允许上传" };
  }
  if (file.size > 500 * 1024 * 1024) {
    return { valid: false, message: "文件大小不能超过 500MB" };
  }
  return { valid: true };
};

<ZustandFileUpload customFileValidator={validator} />
```

校验不通过的文件不会入队，`message` 直接作为提示文案展示。

## 多实例

同页需要多个上传区域时，传入不同 `instanceId`，各自的队列快照与分片缓存互不干扰：

```tsx
<ZustandFileUpload instanceId="invoice" />
<ZustandFileUpload instanceId="contract" />
```

## 自定义表格列

```tsx
<ZustandFileUpload
  visibleColumns={["fileName", "status", "progress"]} // 隐藏「操作」列后行内按钮消失
/>
```

---

## 后端接口契约

统一前缀 `/api/file`，响应体 `{ code, message, data }`（参考实现成功为 `code: 200`）。
**客户端以 HTTP 状态码判定成功**，`message` 会被直接用于错误提示，请写成用户可读的中文。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/file/instant` | 秒传预检 + 已上传分片查询。请求体：`file_id`、`md5`、`name`、`size`、`chunk_md5s`、`chunk_size` |
| GET | `/api/file/status` | 查询某文件已成功上传的分片索引（`file_id`、`md5`） |
| POST | `/api/file/upload` | 上传单个分片，`multipart/form-data`：`file_id`、`index`、`chunk_md5`、`chunk` |
| POST | `/api/file/merge` | 合并分片并落库：`file_id`、`md5`、`name`、`size`、`total` |
| POST | `/api/file/abort` | **删除记录时清理服务端分片**。请求体：`{ file_id }`。由 `uploadApi` 自动推导（`/xxx/upload` → `/xxx/abort`），推导失败回落 `/api/file/abort` |
| GET | `/api/health` | 健康检查 |

`baseURL` 与三个接口路径均可通过 props 覆盖，无需改组件源码。
`/abort` 属于 best-effort：失败不阻塞本地删除，但缺了它会残留孤儿分片，建议实现。

---

## 常见问题

**Q：为什么 `onUploadStart` 没触发？**
只在「上传文件 / 自动上传」真正开启一批时触发。批量重试、单行重试、继续都不触发。

**Q：为什么取消后没有任何回调？**
设计如此。暂停 / 取消 / 删除只改状态，避免把用户主动操作误报成错误。整批取消也不会触发 `onBatchComplete`。

**Q：`maxFiles` 和 `fileConcurrency` 有什么区别？**
`maxFiles` 是**总数上限**（超出整批拒绝），`fileConcurrency` 是**同时上传几个**（其余排队，自动接续）。

**Q：上传成功后记录很快就消失了？**
`autoCleanup` 默认 `true`，完成记录会在 `cleanupDelay`（默认 10）秒后被自动移除。
需要保留结果展示请设 `autoCleanup={false}`。

**Q：`customUploadHandler` 有用吗？**
**当前版本未接线**，传了不生效（仅类型声明）。需要接管上传逻辑请等后续版本，或用 `uploadApi` + 自定义后端协议。

**Q：组件样式没生效？**
必须显式引入 `vane-upload/style.css`；库已把样式标为 `sideEffects`，不会被摇树误删。

**Q：能上传到七牛 / OSS 等直传吗？**
当前版本只走本仓库约定的「预检 → 分片 → 合并」协议，直传需要后端做适配层。

---

## 本地开发

```bash
npm install

npm run dev:server   # 后端 http://localhost:3000（本地演示用 AUTH_MODE=demo 关闭鉴权）
npm run dev          # 前端 http://localhost:5173，/api 代理到 3000
```

构建：

```bash
npm run build        # 演示站点（dist/demo/）+ 库产物（dist/lib/）
npm run build:lib    # 仅库：index.js / index.cjs / index.d.ts / style.css
```

校验：

```bash
npm test             # 前端单测（vitest）
npm run test:server  # 后端接口测试
npm run typecheck    # TypeScript
npm run lint         # ESLint
npm run ci           # 以上全部 + build
```

浏览器端到端与人工回归：见 [`docs/浏览器功能回归手册.md`](docs/浏览器功能回归手册.md)
（含 30 分钟全功能复测路径）与 [`docs/浏览器E2E测试报告-2026-11-08.md`](docs/浏览器E2E测试报告-2026-11-08.md)。
Playwright 冒烟共 **12 条**用例（`npx playwright test`）：上传主流程 VU-63-1 ~ VU-63-11（编号连续无重复），
外加 1 条首字节延迟预算用例（`e2e/first-byte.budget.spec.ts`，守护「上传启动不随文件大小劣化」）。

## 调试

上传链路默认静默，只输出真实错误：

```ts
import { configureDebug, getDebugLog } from "vane-upload";

configureDebug({ silent: false }); // 打开全量日志
console.log(getDebugLog());        // 取环形缓冲
```

组件 `debug` prop 可额外开启 Worker 分片级日志（200ms 节流）。

## 浏览器要求

- 需要 Web Worker、`Blob` / `slice`、`fetch`（现代浏览器均满足）
- 断点续传能力依赖 IndexedDB；隐私模式或空间不足时自动降级为「需重新选择文件」，不会伪装成正在续传
