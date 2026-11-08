# vane-upload TODO 实施清单（简要版）

> 依据：`docs/修复与实施清单.md`（VU-01~22）+ 两轮浏览器测试（E2E-01~04、E2E-R1~R4）。
> 状态口径：浏览器回归实测通过，或对应测试用例确实覆盖并通过，才计 ✅；其余计 ❌。
> 详细证据与复现见 `docs/浏览器功能测试报告.md`、`docs/浏览器回归测试报告-2026-11-08.md`。

**统计：已修复 25 条（其中 P0 4 条）；未修复 4 条（其中 P0 0 条）；不适用/无法验证 3 条。**

依据更新（2026-11-08）：`9c98eb3`（E2E-R1）、`a6b33f1`（E2E-02）、`3dde426`（E2E-03）、方案 A 分片缓存（E2E-01 刷新零点击续传）。
复跑证据：`npm test` 50 文件 / 327 用例全过；`npm run typecheck` 通过；`npm run lint` 0 error；浏览器三场景实测连续两轮全 PASS（见 `docs/浏览器回归测试报告-2026-11-08.md` 第十节）。

---

## ✅ 已修复（25 条）

### P0（4 条）

- ✅ **VU-01** 落盘文件名补用户维度、失败清理不再误删他人文件（租户隔离用例 3 例 + 双账号实测）。
- ✅ **E2E-02** 断点续传分片键跨会话稳定（`a6b33f1`；分片键不再随 `chunkSize` 漂移，浏览器实测刷新后复用已传分片）。
- ✅ **E2E-03** 删除即中止 Worker + 服务端 abort 清理（`3dde426`；浏览器实测删除后 3–4 ms 清空缓存、无复活、服务端无孤儿分片/产物）。
- ✅ **E2E-R1** 刷新后列表恢复（`9c98eb3`；StrictMode 下复用同一恢复 Promise，浏览器实测刷新后 199–208 ms 还原列表）。

### P1（8 条）

- ✅ **E2E-01** 刷新后零点击自动续传：分片字节持久化到 `react-upload-chunks`，刷新后恢复「待上传/上传中」并自动续传（方案 A；浏览器实测 150–163 ms 内自动发出续传请求；缓存缺失时行内 `title` + toast 明确提示「请重新选择文件」，不再误显示为可续传）。
- ✅ **VU-02** 分片写入与状态查询按 `user_id` 隔离（租户隔离用例 + 双账号分片目录实测）。
- ✅ **VU-03** 配额改为 `FileChunk` 数据库聚合，重启/并发不再绕过（配额聚合用例）。
- ✅ **VU-04** 分片状态写盘后同步落库，崩溃窗口不再产生 DB/磁盘不一致（后端用例）。
- ✅ **VU-05** Worker 调试日志对 `Authorization` 等请求头脱敏（`redact.test.ts` 等）。
- ✅ **VU-06** `/instant` 预检失败仍执行 `/status`，不再直接退化为全量重传（`uploadWorker.p2-1.test.ts`）。
- ✅ **VU-07** 取消与错误上报竞态统一归类为 `cancelled`（`uploadWorker.cancel.test.ts`；但取消入口仍缺失，见 E2E-R4）。
- ✅ **VU-08** 合并锁增加等待超时与等待者上限，`mergeKey` 纳入用户维度（后端 hardening 用例）。

### P2（13 条）

- ✅ **VU-09** body parser 移到鉴权后并收紧上限，`chunk_md5s` 逐元素校验（`body-parser-order.test.js`）。
- ✅ **VU-10** multer 超限不再映射为 500，避免客户端无意义重试（`hardening-round2.test.js`）。
- ✅ **VU-11** 删除缓存失效后的全目录 `stat` 扫描，统一走数据库聚合（配额聚合用例）。
- ✅ **VU-12** 新增幂等 `migrateDatabase()`，不再依赖 `sync()` 重建表（`migration.test.js`）。
- ✅ **VU-13** `applyStatement` 参数绑定改为一次规范化一次执行，真实 SQL 错误不再被回退掩盖（后端用例）。
- ✅ **VU-14** 删除 `thumbnail.js` 死代码并移除未使用依赖 `sharp`/`mime-types`（hardening 断言用例）。
- ✅ **VU-15** janitor 增加「在飞合并」保护谓词（`janitor-protection.test.js`；暂停超 TTL 子项仍未运行期验证，见下方说明）。
- ✅ **VU-16** `UploadContext` 引擎改 `useMemo([instanceId])`、context 逐字段 memo（`referenceStability.test.tsx` 4 例）。
- ✅ **VU-17** 计时键改为 `file.id`，卸载时显式 reject 预处理 Promise（`useFileProcessor.test.tsx`）。
- ✅ **VU-18** 取消每 120ms 全量读 IDB，改即时内存同步 + 批次结束一次对账（`useUploaderLifecycle.test.tsx`）。
- ✅ **VU-19** 按内容指纹去重，重复选择同一文件不再新增记录（`uploadDedupe.test.ts` + 浏览器 S09 实测）。
- ✅ **VU-20** 重启 react-hooks v7 规则（`npm run lint` 0 error / 9 warning）。
- ✅ **VU-22** 启用 `React.StrictMode`（开发期双调用已生效；其暴露的 E2E-R1 已由 `9c98eb3` 修复）。

---

## ❌ 未修复（4 条）

### P1（3 条）

- ❌ **E2E-04** 后端不可用时仍有约 15 s 静默期才给出可读错误提示（较上轮 27 s 改善，但未达快速失败）。
- ❌ **E2E-R2** 非法扩展名前端无白名单，`.exe` 传完全部分片后 `/merge` 才返回 415，行内无失败原因。
- ❌ **E2E-R3** 任意新选文件都会把历史 ERROR 记录一并自动重试，重复上传失败文件并污染批量失败计数。

### P2（1 条）

- ❌ **E2E-R4** 无独立「取消上传」入口；`3dde426` 后上传中删除可用并真实 abort，但「取消并保留列表」语义仍不可达。

---

## ⚪ 不适用 / 无法验证（3 条）

- ⚪ **VU-21** Cookie 鉴权 CSRF/SameSite：已确认非源码缺陷，由部署方/网关决定，属运维基线。
- ⚪ **S11 非法类型前端拦截**：`allowedFileTypes = []`，前端无触发路径，只能验证后端 415 兜底（见 E2E-R2）。
- ⚪ **VU-15 残留子项**：暂停超过 janitor TTL 的分片仍可能被清理，暂停语义未做运行期验证。

> 移除项：原「取消上传的底层中止行为」无法验证 —— `3dde426` 后「上传中删除」可实测 Worker 真实 abort（场景 C 通过）；原 ❌ 区的 E2E-02 / E2E-03 / E2E-R1 / E2E-01 已按上方 ✅ 区证据移入「已修复」。
