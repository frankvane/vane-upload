/**
 * VU-59 [P1] 后端关键用例集成测试（TC-01 ~ TC-24）
 * --------------------------------------------------------------------------
 * 落地范围：后端可直接覆盖的用例（TC-01~TC-14、TC-20~TC-24）。
 * 前端专属用例（TC-15 取消 / TC-16 暂停恢复 / TC-17 刷新恢复 / TC-18 IndexedDB
 * 降级 / TC-19 网络自适应）在浏览器侧才有对应执行路径，后端无等价接口，
 * 一律在本文件顶部以 frontend-covered-elsewhere 标注并 skip，不强行伪造。
 *
 * 隔离约定（VU-61）：本文件在模块加载期用 mkdtempSync 在仓库外开辟一个私有
 * 临时根目录，把 DB_STORAGE / SERVER_TMP_UPLOAD_DIR / SERVER_UPLOADS_DIR 全部
 * 重定向到该目录，after() 整体删除，绝不触碰仓库内真实 data/tmp/uploads。
 * 注意：Sequelize 连接是在 database.js 模块加载期依据 DB_STORAGE 创建的
 * 进程级单例，无法在每个 beforeEach 重新指向新库；因此采用「文件级单一临时库 +
 * 每用例 syncModels({force:true}) 重置表 + afterEach 清理落盘目录」的等价隔离
 * 策略（与 file-api.test.js / hardening.test.js 既有的临时 DB 写法一致），
 * 同样保证仓库零新增文件。
 *
 * 运行：cd /e/vane-upload && node --test server/tests/vu59-cases.test.js
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const express = require("express");

// VU-61：所有路径 / DB 在 require app 之前就重定向到仓库外的私有临时目录。
process.env.NODE_ENV = "test";
process.env.AUTH_MODE = "demo";
process.env.RATE_LIMIT_ENABLED = "false";
// TC-03/TC-04 的分片上限边界：CHUNK_MAX_SIZE_MB 在 multer 中间件加载期读取，
// 必须在 require("../src/app") 之前设定。multer 在 fileSize === fileSizeLimit
// 时触发 LIMIT_FILE_SIZE（off-by-one），故中间件把 fileSize 上限设为
// CHUNK_MAX_SIZE_MB 字节 + 1，使「恰好 1 MiB」可放行、只有「1 MiB + 1 字节」
// 才 413（VU-59 修复 off-by-one，见 TC-03/TC-04）。
process.env.CHUNK_MAX_SIZE_MB = "1";
// TC-07/TC-08 的分片数上限：MAX_CHUNKS 在请求期读取，但全局固定为 5 对所有用例安全
// （本文件多分片用例均 <= 5 片）。
process.env.MAX_CHUNKS = "5";
process.env.CHUNK_STATE_FLUSH_INTERVAL_MS = "60000";
process.env.CHUNK_STATE_MAX_PENDING = "99999";

const TEST_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "rui-vu59-"));
process.env.DB_STORAGE = path.join(TEST_ROOT, "vu59.sqlite");
process.env.SERVER_TMP_UPLOAD_DIR = path.join(TEST_ROOT, "tmp");
process.env.SERVER_UPLOADS_DIR = path.join(TEST_ROOT, "uploads");

const app = require("../src/app");
const errorHandler = require("../src/app").errorHandler;
const { syncModels, sequelize, File, FileChunk } = require("../src/models");
const { TMP_UPLOAD_DIR, UPLOADS_DIR } = require("../src/config/paths");
const { md5Buffer } = require("../src/utils/hash");
const {
  buildChunkPath,
  buildScopedFileId,
} = require("../src/utils/fileSecurity");
const {
  resetChunkStateQueueForTests,
} = require("../src/services/chunkStateQueue");
const { getChunkUsage } = require("../src/services/quotaService");
const { sweepOrphanChunks } = require("../src/janitor");
const { createAuthMiddleware } = require("../src/middleware/auth");
const fileRoutes = require("../src/routes/fileRoutes");

// TC-23 鉴权 + 租户：同一进程内另起一个「secure 模式」Express 应用，
// 挂载真实鉴权中间件 + 真实路由，使用两把互不相同的有效令牌（A / B）。
const TOKEN_A = "vu59-token-aaaa";
const TOKEN_B = "vu59-token-bbbb";
const authApp = express();
authApp.use(
  "/api/file",
  createAuthMiddleware({ bearerTokens: [TOKEN_A, TOKEN_B], requireAuth: true })
);
authApp.use(
  "/api/file",
  express.json({ limit: "8mb" }),
  express.urlencoded({ extended: true, limit: "8mb" })
);
authApp.use("/api/file", fileRoutes);
authApp.use(errorHandler);

// ---- 请求 helper（复用 file-api.test.js 的 supertest 写法）----
const withAuth = (req, token) =>
  token ? req.set("Authorization", `Bearer ${token}`) : req;

const uploadChunk = (target, { fileId, index, buffer, chunkMd5, authToken }) => {
  const md5 = chunkMd5 || md5Buffer(buffer);
  const req = request(target)
    .post("/api/file/upload")
    .field("file_id", fileId)
    .field("index", String(index))
    .field("chunk_md5", md5)
    .attach("chunk", buffer, { filename: `${fileId}.bin` });
  return withAuth(req, authToken);
};

const merge = (
  target,
  { fileId, md5, name, size, total, hashMode, authToken, extra }
) => {
  const req = request(target)
    .post("/api/file/merge")
    .send({
      file_id: fileId,
      md5,
      name,
      size,
      total,
      hash_mode: hashMode,
      ...(extra || {}),
    });
  return withAuth(req, authToken);
};

const instant = (target, { fileId, md5, name, size, chunk_md5s, authToken }) => {
  const req = request(target)
    .post("/api/file/instant")
    .send({ file_id: fileId, md5, name, size, chunk_md5s });
  return withAuth(req, authToken);
};

const statusQ = (target, fileId, authToken) => {
  const req = request(target).get("/api/file/status").query({ file_id: fileId });
  return withAuth(req, authToken);
};

const scoped = (fileId) => buildScopedFileId("test", fileId);

// ---- 生命周期 ----
test.before(async () => {
  await syncModels({ force: true });
});

test.beforeEach(async () => {
  await syncModels({ force: true });
  await resetChunkStateQueueForTests();
});

test.afterEach(() => {
  // 只删本文件在临时目录内产生的落盘产物，绝不递归清理仓库目录。
  for (const dir of [TMP_UPLOAD_DIR, UPLOADS_DIR]) {
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      if (fs.lstatSync(full).isFile()) fs.unlinkSync(full);
    }
  }
});

test.after(async () => {
  await sequelize.close();
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
});

// =========================================================================
// 前端专属用例：backend 无对应路径，skip 并标注 frontend-covered-elsewhere。
// =========================================================================
test(
  "TC-15 取消（abort 在途 fetch，不发 error/done、不再发起请求）",
  { skip: true },
  () => {
    // frontend-covered-elsewhere：依赖浏览器 fetch abort + 前端状态机，
    // 后端 /api/file 无「取消」概念，请求一旦到达即被处理，无法在后端复现。
  }
);

test(
  "TC-16 暂停/恢复（断点续传不重传已完成分片）",
  { skip: true },
  () => {
    // frontend-covered-elsewhere：依赖前端 uploadPolicy 状态机在 in-flight 时
    // 挂起新请求；后端分片上传天然幂等、可断点续传，无专属接口可测。
  }
);

test(
  "TC-17 刷新恢复（IDB UPLOADING + fileRef 丢失 → awaitingReselect）",
  { skip: true },
  () => {
    // frontend-covered-elsewhere：依赖 IndexedDB 持久化与前端重选流程，
    // 后端仅按 file_id 提供 status 查询，恢复逻辑全在前端。
  }
);

test(
  "TC-18 IndexedDB 降级（mock 不可用 → 不白屏、主流程可继续）",
  { skip: true },
  () => {
    // frontend-covered-elsewhere：依赖浏览器 indexedDB 可用性探测与降级分支，
    // 后端无浏览器存储概念。
  }
);

test(
  "TC-19 网络自适应（rtt 触发 chunkSize 8MB→256KB、reset:true、旧分片清理）",
  { skip: true },
  () => {
    // frontend-covered-elsewhere：依赖前端网络探测与 chunkKey 重建逻辑；
    // 后端 /instant 的 reset 分支（chunkSize 变更）可后端测，但「网络自适应
    // 触发」本身在前端，故整条场景归入前端。
  }
);

// =========================================================================
// TC-01：0 字节文件边界
// =========================================================================
test("TC-01 0 字节分片上传成功，merge size=0 生成 0 字节产物（200，产物为空、DB 有记录）", async () => {
  const empty = Buffer.alloc(0);
  const emptyMd5 = md5Buffer(empty);
  const up = await uploadChunk(app, {
    fileId: "tc01",
    index: 0,
    buffer: empty,
  });
  assert.equal(up.status, 200);
  assert.equal(up.body.code, 200);

  // 真 0 字节文件（单分片 0 字节，total=1）应被正常合并：产物为 0 字节文件、
  // DB 落一条 size=0 记录，绝不 400 / 422 / 500（VU-59 修复 size>=1 误拒）。
  const mr = await merge(app, {
    fileId: "tc01",
    md5: emptyMd5,
    name: "tc01.bin",
    size: 0,
    total: 1,
  });
  assert.equal(mr.status, 200);
  assert.equal(mr.body.code, 200);

  // 0 字节产物确实落盘且为空。
  const row = await File.findOne({ where: { file_id: `test:tc01` } });
  assert.ok(row, "应当生成 0 字节文件的合并记录");
  assert.equal(row.size, 0);
  const abs = path.join(UPLOADS_DIR, path.basename(row.file_path));
  assert.equal(fs.existsSync(abs), true);
  assert.equal(fs.readFileSync(abs).length, 0);
});

// =========================================================================
// TC-02：1 字节分片边界
// =========================================================================
test("TC-02 1 字节分片上传→status [0]→merge 后长度/md5 正确", async () => {
  const content = Buffer.from("X");
  const md5 = md5Buffer(content);
  const up = await uploadChunk(app, {
    fileId: "tc02",
    index: 0,
    buffer: content,
  });
  assert.equal(up.status, 200);

  const st = await statusQ(app, "tc02");
  assert.equal(st.status, 200);
  assert.deepEqual(st.body.data.chunks, [0]);

  const mr = await merge(app, {
    fileId: "tc02",
    md5,
    name: "tc02.bin",
    size: content.length,
    total: 1,
  });
  assert.equal(mr.status, 200);
  assert.equal(mr.body.code, 200);

  const row = await File.findOne({ where: { md5, size: 1, user_id: "test" } });
  assert.ok(row);
  const abs = path.join(UPLOADS_DIR, path.basename(row.file_path));
  assert.equal(md5Buffer(fs.readFileSync(abs)), md5);
  assert.equal(fs.readFileSync(abs).length, 1);
});

// =========================================================================
// TC-03 / TC-04：分片大小上限边界（BVA）
// =========================================================================
test("TC-03 分片恰好等于声明上限（1MiB）→ 200 不触发 413（VU-59 off-by-one 已修复）", async () => {
  // 修复 off-by-one 后：恰好 CHUNK_MAX_SIZE_MB（1 MiB）的分片应当放行。
  const buf = Buffer.alloc(1024 * 1024, 7); // 恰好 1 MiB，等于声明上限
  const up = await uploadChunk(app, {
    fileId: "tc03",
    index: 0,
    buffer: buf,
  });
  assert.equal(up.status, 200);
  assert.equal(up.body.code, 200);
});

test("TC-04 分片超上限（1 MiB + 1 字节）→ 413 且响应为标准三段式 {code,message,data}", async () => {
  const buf = Buffer.alloc(1024 * 1024 + 1, 7); // 越过声明上限 1 字节
  const up = await uploadChunk(app, {
    fileId: "tc04",
    index: 0,
    buffer: buf,
  });
  assert.equal(up.status, 413);
  assert.equal(up.body.code, 413);
  assert.equal(typeof up.body.message, "string");
  assert.ok("code" in up.body && "message" in up.body && "data" in up.body);
});

// =========================================================================
// TC-05：total=0 边界
// =========================================================================
test("TC-05 merge total=0 → 400，无 staging 残留", async () => {
  await uploadChunk(app, {
    fileId: "tc05",
    index: 0,
    buffer: Buffer.from("a"),
  });
  const mr = await merge(app, {
    fileId: "tc05",
    md5: md5Buffer(Buffer.from("a")),
    name: "tc05.bin",
    size: 1,
    total: 0,
  });
  assert.equal(mr.status, 400);
  assert.equal(mr.body.code, 400);

  const tmpFiles = fs.readdirSync(TMP_UPLOAD_DIR);
  assert.ok(!tmpFiles.some((f) => f.endsWith(".part")), "staging 不应残留");
});

// =========================================================================
// TC-06：total=1 边界
// =========================================================================
test("TC-06 单分片 merge → 200，FileChunk 全 status=2", async () => {
  const content = Buffer.from("hello");
  await uploadChunk(app, {
    fileId: "tc06",
    index: 0,
    buffer: content,
  });
  const mr = await merge(app, {
    fileId: "tc06",
    md5: md5Buffer(content),
    name: "tc06.bin",
    size: content.length,
    total: 1,
  });
  assert.equal(mr.status, 200);
  assert.equal(mr.body.code, 200);

  const chunks = await FileChunk.findAll({
    where: { file_id: scoped("tc06") },
  });
  assert.ok(chunks.length >= 1);
  assert.ok(chunks.every((c) => c.status === 2));
});

// =========================================================================
// TC-07 / TC-08：MAX_CHUNKS 边界
// =========================================================================
test("TC-07 index 0..4（恰好 MAX_CHUNKS=5）全放行，total=5 合并成功", async () => {
  const parts = [];
  for (let i = 0; i < 5; i += 1) {
    const b = Buffer.from(`chunk${i}`);
    parts.push(b);
    await uploadChunk(app, { fileId: "tc07", index: i, buffer: b });
  }
  const merged = Buffer.concat(parts);
  const mr = await merge(app, {
    fileId: "tc07",
    md5: md5Buffer(merged),
    name: "tc07.bin",
    size: merged.length,
    total: 5,
  });
  assert.equal(mr.status, 200);
  assert.equal(mr.body.code, 200);
});

test("TC-08 index=5 / total=6（超 MAX_CHUNKS=5）→ 400，不创建 staging", async () => {
  // 越界 index：parseStrictInt index 上限为 MAX_CHUNKS-1 = 4
  const overIndex = await uploadChunk(app, {
    fileId: "tc08",
    index: 5,
    buffer: Buffer.from("x"),
    chunkMd5: md5Buffer(Buffer.from("x")),
  });
  assert.equal(overIndex.status, 400);
  assert.equal(overIndex.body.code, 400);

  // 越界 total
  const overTotal = await merge(app, {
    fileId: "tc08b",
    md5: md5Buffer(Buffer.from("x")),
    name: "tc08b.bin",
    size: 1,
    total: 6,
  });
  assert.equal(overTotal.status, 400);
  assert.equal(overTotal.body.code, 400);

  const tmpFiles = fs.readdirSync(TMP_UPLOAD_DIR);
  assert.ok(!tmpFiles.some((f) => f.endsWith(".part")));
});

// =========================================================================
// TC-09：文件名遍历 / 非法字符 → 不越出 UPLOADS_DIR
// =========================================================================
test("TC-09 恶意文件名（遍历/非法字符/空格/null/超长）均不越出 UPLOADS_DIR", async () => {
  const malicious = [
    "../../etc/passwd",
    '<>:"/\\|?*',
    "   ",
    "a\u0000b",
    "x".repeat(4096),
  ];
  for (let i = 0; i < malicious.length; i += 1) {
    const nm = malicious[i];
    const fid = `tc09-${i}`;
    const content = Buffer.from(`safe-content-${i}`);
    await uploadChunk(app, { fileId: fid, index: 0, buffer: content });
    const mr = await merge(app, {
      fileId: fid,
      md5: md5Buffer(content),
      name: nm,
      size: content.length,
      total: 1,
    });
    assert.equal(mr.status, 200, `merge 应成功，name=${JSON.stringify(nm)}`);

    const row = await File.findOne({ where: { file_id: `test:${fid}` } });
    assert.ok(row, "应有合并记录");
    const abs = path.resolve(UPLOADS_DIR, path.basename(row.file_path));
    // 落盘文件必须仍解析在 UPLOADS_DIR 之内，绝不逃逸到父目录。
    assert.ok(
      abs.startsWith(path.resolve(UPLOADS_DIR) + path.sep),
      `落盘路径必须位于 UPLOADS_DIR 内，实际=${abs}`
    );
    assert.equal(fs.existsSync(abs), true);
    assert.equal(fs.readFileSync(abs).toString(), content.toString());
  }
});

// =========================================================================
// TC-10：md5 格式非法 → 400；/instant 当前不校验格式（锁定预期）
// =========================================================================
test("TC-10 merge md5 格式非法（31/33位/含 ../）→ 400；/instant 不校验（锁定现状）", async () => {
  const content = Buffer.from("abc");
  await uploadChunk(app, { fileId: "tc10", index: 0, buffer: content });

  const badMd5s = [
    "abc", // 31 位以下
    "d41d8cd98f00b204e9800998ecf8427eextra", // 33 位以上
    "d4/../..", // 含路径分隔符
  ];
  for (const bad of badMd5s) {
    const mr = await merge(app, {
      fileId: "tc10",
      md5: bad,
      name: "tc10.bin",
      size: 3,
      total: 1,
    });
    assert.equal(mr.status, 400, `非法 md5=${bad} 应 400`);
    assert.equal(mr.body.code, 400);
  }

  // /instant 当前未校验 md5 格式：非法 md5 不 400，仅按「查不到」返回 uploaded:false。
  // 用例锁定当前行为，避免后续改动无声改变契约。
  const inst = await instant(app, {
    fileId: "tc10b",
    md5: "abc",
    name: "tc10b.bin",
    size: 3,
  });
  assert.equal(inst.status, 200);
  assert.equal(inst.body.code, 200);
  assert.equal(inst.body.data.uploaded, false);
});

// =========================================================================
// TC-11：重复分片覆盖（配额按差额不翻倍、chunk_md5 更新、merge 用新内容）
// =========================================================================
test("TC-11 重复 index 覆盖写：配额不翻倍、DB chunk_md5 更新、merge 用新内容", async () => {
  const fid = "tc11";
  const a = Buffer.from("AAAA");
  const b = Buffer.from("BBBB");
  await uploadChunk(app, { fileId: fid, index: 0, buffer: a });

  const usage1 = await getChunkUsage(scoped(fid));
  assert.equal(usage1.bytes, 4);

  // 同 index、相同大小覆盖：应按差额计费，配额不翻倍。
  await uploadChunk(app, { fileId: fid, index: 0, buffer: b });
  const usage2 = await getChunkUsage(scoped(fid));
  assert.equal(usage2.bytes, 4, "覆盖写后配额不应翻倍");

  // DB 中 chunk_md5 应更新为新内容。
  const chunk = await FileChunk.findOne({
    where: { file_id: scoped(fid), chunk_index: 0 },
  });
  assert.equal(chunk.chunk_md5, md5Buffer(b));

  // merge 使用新内容通过。
  const mr = await merge(app, {
    fileId: fid,
    md5: md5Buffer(b),
    name: "tc11.bin",
    size: b.length,
    total: 1,
  });
  assert.equal(mr.status, 200);
  const row = await File.findOne({ where: { file_id: `test:${fid}` } });
  const abs = path.join(UPLOADS_DIR, path.basename(row.file_path));
  assert.equal(fs.readFileSync(abs).toString(), "BBBB");
});

// =========================================================================
// TC-12：乱序分片合并产物正确
// =========================================================================
test("TC-12 按 4→0→2→1→3 乱序并发上传 → merge 按 index 拼接，产物 md5 一致", async () => {
  const fid = "tc12";
  const order = [4, 0, 2, 1, 3];
  const parts = [];
  for (let i = 0; i < 5; i += 1) parts.push(Buffer.from(`P${i}`));

  await Promise.all(
    order.map((i) =>
      uploadChunk(app, { fileId: fid, index: i, buffer: parts[i] })
    )
  );

  const merged = Buffer.concat(parts); // parts[0..4] 按 index 顺序
  const mr = await merge(app, {
    fileId: fid,
    md5: md5Buffer(merged),
    name: "tc12.bin",
    size: merged.length,
    total: 5,
  });
  assert.equal(mr.status, 200);
  assert.equal(mr.body.code, 200);

  const row = await File.findOne({ where: { file_id: `test:${fid}` } });
  const abs = path.join(UPLOADS_DIR, path.basename(row.file_path));
  assert.equal(md5Buffer(fs.readFileSync(abs)), md5Buffer(merged));
});

// =========================================================================
// TC-13：缺失分片 → 400 且已传分片不被误删
// =========================================================================
test("TC-13 缺失分片（只传 0、2，total=3）→ 400，staging 清理且全部已传分片均保留（断点续传友好）", async () => {
  const fid = "tc13";
  await uploadChunk(app, { fileId: fid, index: 0, buffer: Buffer.from("a") });
  await uploadChunk(app, { fileId: fid, index: 2, buffer: Buffer.from("c") });

  const mr = await merge(app, {
    fileId: fid,
    md5: "0cc175b9c0f1b6a831c399e269772661", // 无关 md5，失败发生在分片缺失校验
    name: "tc13.bin",
    size: 3,
    total: 3,
  });
  assert.equal(mr.status, 400);
  assert.equal(mr.body.code, 400);
  assert.match(mr.body.message, /第 1 个分片不存在/);

  // VU-59 修复：合并失败（缺失分片）时，循环内不删除任何分片，gap 之前（chunk 0）
  // 与 gap 之后（chunk 2）的已传分片都原样保留，客户端可补传 chunk 1 后继续合并。
  assert.equal(
    fs.existsSync(buildChunkPath(scoped(fid), 0)),
    true,
    "gap 之前的已传分片 chunk 0 不应被回滚误删"
  );
  assert.equal(
    fs.existsSync(buildChunkPath(scoped(fid), 2)),
    true,
    "gap 之后的已传分片 chunk 2 不应被误删"
  );

  // 无 staging 残留，且无合并记录。
  const tmpFiles = fs.readdirSync(TMP_UPLOAD_DIR);
  assert.ok(!tmpFiles.some((f) => f.includes(".part")));
  assert.equal(await File.count({ where: { file_id: `test:${fid}` } }), 0);
});

// =========================================================================
// TC-14：并发合并同键仅 1 次落盘
// =========================================================================
test("TC-14 并发合并同键（10 个 Promise.all）→ 仅 1 次落盘，File 表 1 行", async () => {
  const fid = "tc14";
  const parts = [];
  for (let i = 0; i < 5; i += 1) {
    const b = Buffer.from(`Q${i}`);
    parts.push(b);
    await uploadChunk(app, { fileId: fid, index: i, buffer: b });
  }
  const merged = Buffer.concat(parts);
  const md5 = md5Buffer(merged);

  const merges = Array.from({ length: 10 }, () =>
    merge(app, {
      fileId: fid,
      md5,
      name: "tc14.bin",
      size: merged.length,
      total: 5,
    })
  );
  const results = await Promise.all(merges);
  for (const r of results) {
    assert.equal(r.status, 200);
    assert.equal(r.body.code, 200);
  }

  const count = await File.count({
    where: { md5, size: merged.length, user_id: "test" },
  });
  assert.equal(count, 1, "并发合并同键只能落盘 1 行 File 记录");

  const row = await File.findOne({
    where: { md5, size: merged.length, user_id: "test" },
  });
  const abs = path.join(UPLOADS_DIR, path.basename(row.file_path));
  assert.equal(md5Buffer(fs.readFileSync(abs)), md5);
});

// =========================================================================
// TC-20：秒传命中
// =========================================================================
test("TC-20 秒传命中：A 换 file_id 仍 uploaded:true；B 为 false；DTO 无 user_id/file_path", async () => {
  const content = Buffer.from("instant-content");
  const md5 = md5Buffer(content);
  await uploadChunk(app, { fileId: "tc20", index: 0, buffer: content });
  const mr = await merge(app, {
    fileId: "tc20",
    md5,
    name: "tc20.bin",
    size: content.length,
    total: 1,
  });
  assert.equal(mr.status, 200);

  // A 换一个 file_id（模拟不同 chunkSize / 重试）再次 instant → 命中。
  const instA = await instant(app, {
    fileId: "tc20-alt",
    md5,
    name: "tc20.bin",
    size: content.length,
  });
  assert.equal(instA.status, 200);
  assert.equal(instA.body.data.uploaded, true);
  assert.ok(instA.body.data.file);
  // P2-9：DTO 不得泄漏内部字段。
  assert.equal("user_id" in instA.body.data.file, false);
  assert.equal("file_path" in instA.body.data.file, false);

  // 不同 md5 的 B → 未命中。
  const instB = await instant(app, {
    fileId: "tc20-b",
    md5: "deadbeefdeadbeefdeadbeefdeadbeef",
    name: "tc20b.bin",
    size: 5,
  });
  assert.equal(instB.body.data.uploaded, false);
});

// =========================================================================
// TC-21：配额恰好上限放行
// =========================================================================
test("TC-21 累计字节恰好等于单文件上限 → 放行 200（源码均为 > 判断）", async () => {
  const prev = process.env.MAX_UPLOAD_SIZE_MB;
  process.env.MAX_UPLOAD_SIZE_MB = "0.002"; // 2 KiB = 2048 字节
  try {
    const fid = "tc21";
    const buf = Buffer.alloc(2048, 1); // 恰好 2048 字节
    const up = await uploadChunk(app, { fileId: fid, index: 0, buffer: buf });
    assert.equal(up.status, 200);
    assert.equal(up.body.code, 200);

    const usage = await getChunkUsage(scoped(fid));
    assert.equal(usage.bytes, 2048);
  } finally {
    if (prev === undefined) delete process.env.MAX_UPLOAD_SIZE_MB;
    else process.env.MAX_UPLOAD_SIZE_MB = prev;
  }
});

// =========================================================================
// TC-22：配额超 1 字节 → 413 且不落盘/不虚增（单文件 / 换 file_id / 换 user 三维度）
// =========================================================================
test("TC-22 配额超 1 字节（单文件/换 file_id/换 user 三维度）→ 413，不落盘、DB 无记录、用量不虚增", async () => {
  const saveMax = process.env.MAX_UPLOAD_SIZE_MB;
  const saveTotal = process.env.MAX_TOTAL_UPLOAD_SIZE_MB;
  const saveUser = process.env.MAX_USER_UPLOAD_SIZE_MB;
  try {
    // ---- 维度一：单文件累计超限 ----
    // 0.001953125 MiB = 2048 字节（精确值，2^-9 * 2^20 = 2^11）。
    process.env.MAX_UPLOAD_SIZE_MB = "0.001953125"; // 单文件上限 = 2048 字节
    delete process.env.MAX_TOTAL_UPLOAD_SIZE_MB;
    delete process.env.MAX_USER_UPLOAD_SIZE_MB;

    const a = Buffer.alloc(2048, 2); // 恰好 2048 字节（放行）
    assert.equal(
      (await uploadChunk(app, { fileId: "tc22a", index: 0, buffer: a })).status,
      200
    );
    const over = Buffer.alloc(1, 3); // 再传 1 字节 → 2049 > 2048 → 超限
    const r1 = await uploadChunk(app, {
      fileId: "tc22a",
      index: 1,
      buffer: over,
    });
    assert.equal(r1.status, 413);
    assert.equal(r1.body.code, 413);
    // 不落盘、DB 无合并记录、用量不虚增（仍为 2048）。
    assert.equal(
      fs.existsSync(buildChunkPath(scoped("tc22a"), 1)),
      false,
      "超限分片不得落盘"
    );
    assert.equal(await File.count({ where: { file_id: `test:tc22a` } }), 0);
    const usage = await getChunkUsage(scoped("tc22a"));
    assert.equal(usage.bytes, 2048, "用量不得因被拒分片虚增");

    // ---- 维度二：换 file_id（进程全局配额）----
    // 重置表，清除维度一已落库的分片，避免其字节计入全局/用户配额基线。
    await syncModels({ force: true });
    process.env.MAX_UPLOAD_SIZE_MB = "100"; // 单文件宽松
    process.env.MAX_TOTAL_UPLOAD_SIZE_MB = "0.001"; // ~1048 字节
    delete process.env.MAX_USER_UPLOAD_SIZE_MB;

    const g1 = Buffer.alloc(600, 4);
    assert.equal(
      (await uploadChunk(app, { fileId: "tc22b", index: 0, buffer: g1 })).status,
      200
    );
    const g2 = Buffer.alloc(600, 5);
    const r2 = await uploadChunk(app, {
      fileId: "tc22c",
      index: 0,
      buffer: g2,
    });
    assert.equal(r2.status, 413);
    assert.equal(r2.body.code, 413);

    // ---- 维度三：换 user（租户配额，经 authApp）----
    // 重置表，清除维度二的全局配额基线；token-a 的用户配额基线随之清零。
    await syncModels({ force: true });
    process.env.MAX_UPLOAD_SIZE_MB = "100";
    delete process.env.MAX_TOTAL_UPLOAD_SIZE_MB;
    process.env.MAX_USER_UPLOAD_SIZE_MB = "0.001"; // ~1048 字节

    const u1 = Buffer.alloc(600, 6);
    assert.equal(
      (
        await uploadChunk(authApp, {
          fileId: "tc22d",
          index: 0,
          buffer: u1,
          authToken: TOKEN_A,
        })
      ).status,
      200
    );
    const u2 = Buffer.alloc(600, 7);
    const r3 = await uploadChunk(authApp, {
      fileId: "tc22e",
      index: 0,
      buffer: u2,
      authToken: TOKEN_A,
    });
    assert.equal(r3.status, 413);
    assert.equal(r3.body.code, 413);
  } finally {
    if (saveMax === undefined) delete process.env.MAX_UPLOAD_SIZE_MB;
    else process.env.MAX_UPLOAD_SIZE_MB = saveMax;
    if (saveTotal === undefined) delete process.env.MAX_TOTAL_UPLOAD_SIZE_MB;
    else process.env.MAX_TOTAL_UPLOAD_SIZE_MB = saveTotal;
    if (saveUser === undefined) delete process.env.MAX_USER_UPLOAD_SIZE_MB;
    else process.env.MAX_USER_UPLOAD_SIZE_MB = saveUser;
  }
});

// =========================================================================
// TC-23：鉴权 + 租户
// =========================================================================
test("TC-23 鉴权+租户：无/错/畸形/过期 token → 401；跨用户越权不命中", async () => {
  const fileId = "tc23";
  const md5 = "d41d8cd98f00b204e9800998ecf8427e"; // md5("")

  // 4 类接口 × 无/错/畸形/过期（过期在此实现中等价于「不在白名单」）令牌 → 401
  const endpoints = {
    instant: () =>
      instant(authApp, { fileId, md5, name: "x", size: 1 }),
    status: () => statusQ(authApp, fileId),
    upload: () =>
      uploadChunk(authApp, { fileId, index: 0, buffer: Buffer.from("z") }),
    merge: () =>
      merge(authApp, { fileId, md5, name: "x", size: 1, total: 1 }),
  };
  const variants = [
    { name: "no-token", token: null },
    { name: "wrong-token", token: "wrong-token-xyz" },
    { name: "malformed-bearer-only", token: "Bearer" },
    { name: "malformed-scheme", token: "Token abc" },
    { name: "expired(not-whitelisted)", token: "expired-token-000" },
  ];

  for (const epName of Object.keys(endpoints)) {
    for (const v of variants) {
      const req = endpoints[epName]();
      if (v.token) req.set("Authorization", `Bearer ${v.token}`);
      const res = await req;
      assert.equal(
        res.status,
        401,
        `${epName} 在 ${v.name} 下应返回 401`
      );
      assert.equal(res.body.code, 401);
      assert.deepEqual(res.body.data, {});
    }
  }

  // 越权隔离：A 上传并合并一个文件，B（不同令牌 → 不同 userId）不得看到 A 的数据。
  const content = Buffer.from("tenant-secret");
  const aMd5 = md5Buffer(content);
  await uploadChunk(authApp, {
    fileId: "tc23a",
    index: 0,
    buffer: content,
    authToken: TOKEN_A,
  });
  const mA = await merge(authApp, {
    fileId: "tc23a",
    md5: aMd5,
    name: "tc23a.bin",
    size: content.length,
    total: 1,
    authToken: TOKEN_A,
  });
  assert.equal(mA.status, 200);

  // B 用 A 的 file_id 查 instant：必须 uploaded:false（看不到 A 的文件）。
  const instB = await instant(authApp, {
    fileId: "tc23a",
    md5: aMd5,
    name: "tc23a.bin",
    size: content.length,
    authToken: TOKEN_B,
  });
  assert.equal(instB.status, 200);
  assert.equal(instB.body.data.uploaded, false, "B 不得看到 A 的已合并文件");

  // B 用 A 的 file_id 查 status：必须为空（看不到 A 的分片）。
  const stB = await statusQ(authApp, "tc23a", TOKEN_B);
  assert.equal(stB.status, 200);
  assert.deepEqual(stB.body.data.chunks, [], "B 不得看到 A 的分片");

  // B 伪造请求体 user_id 并对 A 的 file_id 发起 merge：身份仍按令牌派生，
  // B 的存储键下无分片 → 400（绝不会动到 A 的文件）。
  const mB = await merge(authApp, {
    fileId: "tc23a",
    md5: aMd5,
    name: "tc23a.bin",
    size: content.length,
    total: 1,
    authToken: TOKEN_B,
    extra: { user_id: "forged-principal" },
  });
  assert.equal(mB.status, 400);
  assert.match(mB.body.message, /第 0 个分片不存在/);
});

// =========================================================================
// TC-24：崩溃重启可续传 + 活跃但 mtime 超 TTL 的分片不被 janitor 误删
// =========================================================================
test("TC-24 崩溃重启可续传；活跃（受保护）但 mtime 超 TTL 的分片不被 janitor 误删", async () => {
  // --- 崩溃重启续传：传 3/5 片后「重启」（重新 status 查询）→ 续传剩余并合并 ---
  const fid = "tc24";
  const parts = [
    Buffer.from("a"),
    Buffer.from("bb"),
    Buffer.from("ccc"),
    Buffer.from("dddd"),
    Buffer.from("eeeee"),
  ];
  for (let i = 0; i < 3; i += 1) {
    await uploadChunk(app, { fileId: fid, index: i, buffer: parts[i] });
  }
  // 模拟重启后新客户端重新查询：已传分片必须仍在（磁盘 + DB 持久化）。
  const st = await statusQ(app, fid);
  assert.equal(st.status, 200);
  assert.deepEqual(st.body.data.chunks, [0, 1, 2]);

  // 续传剩余 3、4 并合并。
  for (let i = 3; i < 5; i += 1) {
    await uploadChunk(app, { fileId: fid, index: i, buffer: parts[i] });
  }
  const merged = Buffer.concat(parts);
  const mr = await merge(app, {
    fileId: fid,
    md5: md5Buffer(merged),
    name: "tc24.bin",
    size: merged.length,
    total: 5,
  });
  assert.equal(mr.status, 200);
  const row = await File.findOne({ where: { file_id: `test:${fid}` } });
  const abs = path.join(UPLOADS_DIR, path.basename(row.file_path));
  assert.equal(md5Buffer(fs.readFileSync(abs)), md5Buffer(merged));

  // --- janitor 竞态：受保护（活跃）但 mtime 超 TTL 的分片不得被 sweep 误删 ---
  const activeSid = "activeStorageXYZ";
  const orphanSid = "orphanStorageXYZ";
  const freshSid = "freshStorageXYZ";
  const activePath = path.join(TMP_UPLOAD_DIR, `${activeSid}_0`);
  const orphanPath = path.join(TMP_UPLOAD_DIR, `${orphanSid}_0`);
  const freshPath = path.join(TMP_UPLOAD_DIR, `${freshSid}_0`);
  fs.writeFileSync(activePath, Buffer.from("active"));
  fs.writeFileSync(orphanPath, Buffer.from("orphan"));
  fs.writeFileSync(freshPath, Buffer.from("fresh"));

  const oldMs = Date.now() - 2 * 24 * 3600 * 1000; // 2 天前
  fs.utimesSync(activePath, oldMs / 1000, oldMs / 1000);
  fs.utimesSync(orphanPath, oldMs / 1000, oldMs / 1000);
  // freshPath 保持当前 mtime。

  const removed = await sweepOrphanChunks({
    ttlMs: 60000, // 1 分钟：新鲜文件（写入于 now 附近）稳留，2 天前的孤儿被清
    now: Date.now(),
    getProtectedFileIds: () => new Set([activeSid]),
  });

  assert.equal(
    fs.existsSync(activePath),
    true,
    "活跃（受保护）分片即便 mtime 超 TTL 也不应被删除"
  );
  assert.equal(
    fs.existsSync(orphanPath),
    false,
    "无引用且 mtime 超 TTL 的孤儿分片应被清理"
  );
  assert.equal(
    fs.existsSync(freshPath),
    true,
    "mtime 新鲜的分片不应被清理"
  );
  assert.ok(removed.includes(`${orphanSid}_0`));
});
