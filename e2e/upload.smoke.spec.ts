import { test, expect, type Page, type Route } from "@playwright/test";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { E2E_UPLOADS_DIR } from "./e2e-paths";

/**
 * VU-63 浏览器级 E2E：覆盖「选 3 文件 → 秒传 1 → 暂停/恢复 1 → 取消 1 → 刷新续传 → 合并完成 → 产物 md5 一致」。
 * 通过真实浏览器驱动真实前端 + 真实后端，最终从后端合并产物目录按 md5 校验产物与源文件一致。
 */

const UPLOADS_DIR = E2E_UPLOADS_DIR;

/**
 * 每次运行生成一个随机盐（单个 worker 内 5 个用例共享），拼到所有 fixture 的内容种子上。
 * 这样即便上一轮运行在 E2E 固定目录里留下了已合并产物，本轮的内容 md5 也不同，
 * 不会被后端「秒传」命中，从而稳定走「分片上传 + 合并 → 已完成」路径。无需删除历史产物。
 */
const RUN_SALT =
  Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function md5(buf: Buffer | string): string {
  return crypto.createHash("md5").update(buf).digest("hex");
}

/** 确定性伪随机内容，保证每个 fixture 内容唯一且可复现。 */
function randContent(size: number, seed: string): Buffer {
  const buf = Buffer.alloc(size);
  let s = seed;
  for (let i = 0; i < size; i += 1) {
    s = crypto.createHash("md5").update(s).digest("hex");
    buf[i] = s.charCodeAt(i % s.length) & 0xff;
  }
  return buf;
}

function fixture(name: string, content: Buffer) {
  return { name, mimeType: "application/octet-stream", buffer: content };
}

/** 在后端合并产物目录中查找 md5 等于 expected 的文件，返回路径或 null。 */
async function findProductFile(expectedMd5: string): Promise<string | null> {
  if (!fs.existsSync(UPLOADS_DIR)) return null;
  for (const f of fs.readdirSync(UPLOADS_DIR)) {
    const p = path.join(UPLOADS_DIR, f);
    try {
      if (md5(fs.readFileSync(p)) === expectedMd5) return p;
    } catch {
      /* 跳过临时/锁文件 */
    }
  }
  return null;
}

const fileInput = (page: Page) => page.locator("#root input[type=file]");

async function uploadFiles(
  page: Page,
  files: { name: string; mimeType: string; buffer: Buffer }[],
) {
  await fileInput(page).setInputFiles(files);
}

/** 等待某文件所在行出现指定状态 Tag（精确匹配中文状态文案）。 */
async function waitRowStatus(
  page: Page,
  fileName: string,
  statusText: string,
  timeout = 45_000,
) {
  const row = page.locator("tbody tr", {
    has: page.locator("td", { hasText: fileName }),
  });
  await expect(row.getByText(statusText, { exact: true })).toBeVisible({
    timeout,
  });
}

/**
 * 可控上传闸口：第 1 个分片立即放行，第 2+ 个分片延迟 `delayMs` 制造「上传中」窗口；
 * 一旦 `gate.paused` 置位，剩余分片直接 abort（不再被延迟回调绕过暂停/取消）。
 *
 * - 暂停类用例传入较小延迟（如 2.5s）：凭借该窗口点击「暂停」，分片在延迟后仍会
 *   完成，从而让 Worker 走到分片边界并上报 paused。
 * - 删除类用例需要「删除一定发生在合并之前」，传入较大延迟（如 8s）：窗口内分片
 *   始终不会落盘，删除即中止 Worker，确保「无合并产物」为确定性断言。
 */
function makeUploadGate(delayMs = 2500) {
  const gate = { paused: false };
  // 闭包级分片序号：所有请求共享同一计数器，确保第 1 片立即放行、第 2+ 片进入延迟/中止。
  // 关键：不能把序号挂在 `route` 上——每条请求都是新的 Route 实例，序号会恒为 1，
  // 使 `n >= 2` 分支永不执行、延迟/中止完全失效（历史上正是此 bug 导致中断类用例全量下抖动）。
  let chunkSeq = 0;
  // route.abort()/continue() 返回 Promise，被响应前若请求已随 Worker terminate 被取消，
  // 这些 Promise 会以 "Route is already handled!" 拒绝。必须显式 .catch 吞掉，
  // 否则会变成未处理的 Promise rejection，把用例判失败（曾导致 VU-63-5 抖动）。
  const safeAbort = (route: Route) => {
    route.abort().catch(() => {
      /* 请求已结束/已处理 */
    });
  };
  const safeContinue = (route: Route) => {
    route.continue().catch(() => {
      /* 请求已结束/已处理 */
    });
  };
  const handler = (route: Route): void => {
    chunkSeq += 1;
    const n = chunkSeq;
    if (n >= 2 && gate.paused) {
      // 已暂停/取消：剩余分片直接中止，避免延迟回调绕过应用层暂停
      safeAbort(route);
      return;
    }
    if (n >= 2) {
      void sleep(delayMs).then(() => {
        // 延迟窗内若已置位 paused（取消/暂停/删除），则把本该 continue 的请求
        // 改为 abort，避免「延迟回调绕过应用层暂停/取消」造成分片泄漏到服务端，
        // 否则「取消→继续」时服务端已合并完整文件、重传命中秒传，断言不稳定。
        if (gate.paused) {
          safeAbort(route);
          return;
        }
        safeContinue(route);
      });
    } else {
      safeContinue(route);
    }
  };
  return { gate, handler };
}

test.beforeEach(async ({ page }) => {
  await page.goto("/e2e.html");
  // 等待上传组件渲染（隐藏的文件输入框出现）
  await expect(fileInput(page)).toBeAttached();
});

test("VU-63-1 选 3 个文件上传并校验产物 md5 一致", async ({ page }) => {
  const specs = [
    { name: "alpha.bin", size: 8 * 1024, seed: "vu63-alpha" },
    { name: "bravo.bin", size: 16 * 1024, seed: "vu63-bravo" },
    { name: "charlie.bin", size: 24 * 1024, seed: "vu63-charlie" },
  ];
  const files = specs.map((s) => {
    const content = randContent(s.size, s.seed + RUN_SALT);
    return { ...fixture(s.name, content), _md5: md5(content), _content: content };
  });

  await uploadFiles(page, files);

  for (const f of files) {
    await waitRowStatus(page, f.name, "已完成");
  }

  for (const f of files) {
    const product = await findProductFile(f._md5);
    expect(product, `产物 ${f.name} 的 md5 应与源文件一致`).not.toBeNull();
  }
});

test("VU-63-2 重复内容文件触发秒传（秒传成功）", async ({ page }) => {
  const content = randContent(32 * 1024, "vu63-instant" + RUN_SALT);
  const expectedMd5 = md5(content);

  // 先上传原始文件，使后端落盘合并产物
  await uploadFiles(page, [fixture("orig.bin", content)]);
  await waitRowStatus(page, "orig.bin", "已完成");
  expect(await findProductFile(expectedMd5)).not.toBeNull();

  // 再以不同文件名上传相同内容 → 后端命中 md5+size → 秒传（确定性契约，T-50 收窄为单状态）
  await uploadFiles(page, [fixture("dup.bin", content)]);
  await waitRowStatus(page, "dup.bin", "秒传成功");

  // 秒传不产生新合并产物，但既有产物 md5 仍与源一致
  expect(await findProductFile(expectedMd5)).not.toBeNull();
});

test("VU-63-3 暂停后继续并完成，产物 md5 一致", async ({ page }) => {
  const content = randContent(3 * 1024 * 1024, "vu63-pause" + RUN_SALT);
  const expectedMd5 = md5(content);
  const file = fixture("pause-spec.bin", content);

  const { handler } = makeUploadGate();
  await page.route("**/api/file/upload", handler);

  await uploadFiles(page, [file]);
  await waitRowStatus(page, "pause-spec.bin", "上传中", 20_000);

  const row = page.locator("tbody tr", {
    has: page.locator("td", { hasText: "pause-spec.bin" }),
  });
  await row.getByRole("button", { name: "暂停" }).click();
  await waitRowStatus(page, "pause-spec.bin", "已暂停", 10_000);

  await page.unroute("**/api/file/upload");
  await row.getByRole("button", { name: "继续" }).click();

  // 终态接受「已完成」或「秒传成功」（同 VU-63-5/63-6）：暂停窗口内若剩余分片已落盘、
  // 恢复时命中秒传，则为「秒传成功」；否则为「已完成」。二者均代表产物就绪且与源一致。
  await expect(
    row.getByText("已完成", { exact: true }).or(
      row.getByText("秒传成功", { exact: true }),
    ),
  ).toBeVisible({ timeout: 45_000 });
  expect(await findProductFile(expectedMd5)).not.toBeNull();
});

test("VU-63-4 E2E-03 上传中「删除」真实中止 Worker 并清理，无合并产物", async ({
  page,
}) => {
  const content = randContent(3 * 1024 * 1024, "vu63-cancel" + RUN_SALT);
  const expectedMd5 = md5(content);
  const file = fixture("cancel-spec.bin", content);

  // 删除类用例：用较长延迟确保「删除时上传仍在进行」，否则全量套件下上传可能已先合并，
  // abortServerChunks 只清分片不清产物，导致「无合并产物」断言偶发失败。
  const { gate, handler } = makeUploadGate(8_000);
  await page.route("**/api/file/upload", handler);

  await uploadFiles(page, [file]);
  await waitRowStatus(page, "cancel-spec.bin", "上传中", 20_000);
  // 置位闸口：剩余分片直接中止，避免延迟回调绕过应用的删除中止
  gate.paused = true;

  const row = page.locator("tbody tr", {
    has: page.locator("td", { hasText: "cancel-spec.bin" }),
  });
  // 上传中点击「删除」：应真实中止传输（E2E-03 修复点）
  await row.getByRole("button", { name: "删除" }).click();

  await expect(
    page.locator("tbody tr", {
      has: page.locator("td", { hasText: "cancel-spec.bin" }),
    })
  ).toHaveCount(0, { timeout: 10_000 });

  // 删除后不应产生合并产物（仅可能有孤儿分片存于 tmp，不影响校验）
  expect(await findProductFile(expectedMd5)).toBeNull();
});

test("VU-63-5 刷新页面后重新选择可续传并完成", async ({ page }) => {
  const content = randContent(2 * 1024 * 1024, "vu63-refresh" + RUN_SALT);
  const expectedMd5 = md5(content);

  const { gate, handler } = makeUploadGate();
  await page.route("**/api/file/upload", handler);

  await uploadFiles(page, [fixture("resume-spec.bin", content)]);
  await waitRowStatus(page, "resume-spec.bin", "上传中", 20_000);

  const row = page.locator("tbody tr", {
    has: page.locator("td", { hasText: "resume-spec.bin" }),
  });
  // 置位闸口，避免延迟回调在暂停后绕过应用层把剩余分片续传完成
  gate.paused = true;
  await row.getByRole("button", { name: "暂停" }).click();
  await waitRowStatus(page, "resume-spec.bin", "已暂停", 10_000);

  await page.unroute("**/api/file/upload");
  // 刷新：模拟用户离开页面后返回，IndexedDB 恢复中断任务
  await page.reload();
  // 恢复后原文件应以「上传失败/已暂停」等形式重新出现在列表中
  await expect(page.getByText("resume-spec.bin")).toBeVisible({
    timeout: 20_000,
  });

  // 以不同文件名重新选择相同内容（content key 不同 → 新队列条目；file_id 由内容派生 → 服务端命中已有分片续传）。
  // 刷新后续传的终态可能是「已完成」（服务端重新合并）或「秒传成功」（原上传已在服务端合并、命中 md5+size），
  // 二者都代表产物已就绪且与源一致，这里接受两种终态。
  await uploadFiles(page, [fixture("resume-spec-reselect.bin", content)]);

  const reselectRow = page.locator("tbody tr", {
    has: page.locator("td", { hasText: "resume-spec-reselect.bin" }),
  });
  await expect(
    reselectRow.getByText("已完成", { exact: true }).or(
      reselectRow.getByText("秒传成功", { exact: true }),
    ),
  ).toBeVisible({ timeout: 45_000 });

  expect(await findProductFile(expectedMd5)).not.toBeNull();
});

/**
 * 以下用例覆盖「用户修复批次」中已落地的关键能力（E2E-R2 / E2E-R3 / E2E-R4 / E2E-04
 * 与同会话重试、重复上传去重），均经真实浏览器 + 真实后端验证。
 * 复用上面定义的 RUN_SALT / randContent / findProductFile / makeUploadGate 等。
 */

test("VU-63-6 E2E-R4 上传中点「取消」中止传输并保留记录，可「继续」完成", async ({
  page,
}) => {
  const content = randContent(3 * 1024 * 1024, "vu63-cancel-entry" + RUN_SALT);
  const expectedMd5 = md5(content);
  const file = fixture("cancel-entry.bin", content);

  const { gate, handler } = makeUploadGate();
  await page.route("**/api/file/upload", handler);

  await uploadFiles(page, [file]);
  await waitRowStatus(page, "cancel-entry.bin", "上传中", 20_000);
  // 置位闸口，避免延迟回调在取消后绕过应用层把剩余分片续传完成
  gate.paused = true;

  const row = page.locator("tbody tr", {
    has: page.locator("td", { hasText: "cancel-entry.bin" }),
  });
  // 上传中可见独立「取消」入口（与「删除」职责分离）
  await row.getByRole("button", { name: "取消" }).click();
  // 取消后停留在已暂停并保持记录（不移除、不清分片缓存）
  await waitRowStatus(page, "cancel-entry.bin", "已暂停", 10_000);
  await expect(row).toHaveCount(1);

  await page.unroute("**/api/file/upload");
  await row.getByRole("button", { name: "继续" }).click();

  // 终态接受「已完成」或「秒传成功」：若取消瞬间残留分片已落到服务端、
  // 重传命中秒传，则状态为「秒传成功」；否则为「已完成」。二者均代表产物已就绪且与源一致。
  await expect(
    row.getByText("已完成", { exact: true }).or(
      row.getByText("秒传成功", { exact: true }),
    ),
  ).toBeVisible({ timeout: 45_000 });
  expect(await findProductFile(expectedMd5)).not.toBeNull();
});

test("VU-63-7 E2E-R2 危险扩展名在选择阶段拦截，不进入列表、不发分片请求", async ({
  page,
}) => {
  const uploadHits: string[] = [];
  await page.route("**/api/file/upload", (route) => {
    uploadHits.push(route.request().url());
    void route.continue();
  });

  // 选一个危险扩展名文件（命中前后端共用的 dangerous-file-types 清单）
  await uploadFiles(page, [
    { name: "evil.exe", mimeType: "application/octet-stream", buffer: Buffer.from("x") },
  ]);

  // 选择阶段即拦截并给出可读原因
  await expect(
    page.getByText(/不允许上传的类型|危险扩展名/),
  ).toBeVisible({ timeout: 10_000 });

  // 等待一会儿，确认没有任何分片上传请求发出
  await sleep(800);
  await page.unroute("**/api/file/upload");

  // 列表里不应出现该文件行
  await expect(
    page.locator("tbody tr", { has: page.locator("td", { hasText: "evil.exe" }) }),
  ).toHaveCount(0);
  expect(uploadHits.length, "危险类型不应触发任何分片上传").toBe(0);
});

test("VU-63-8 E2E-04 后端不可用快速失败，恢复后可重试完成", async ({ page }) => {
  // 模拟后端不可用：中止所有 /api/file 请求（连接级错误）
  await page.route("**/api/file/**", (route) => void route.abort());

  const content = randContent(64 * 1024, "vu63-offline" + RUN_SALT);
  const expectedMd5 = md5(content);
  await uploadFiles(page, [fixture("offline.bin", content)]);

  const row = page.locator("tbody tr", {
    has: page.locator("td", { hasText: "offline.bin" }),
  });
  // 关键修复点：连接级错误不再长时间静默重试，应在 ~20s 内进入「上传失败」
  await waitRowStatus(page, "offline.bin", "上传失败", 20_000);

  // 恢复后端，显式重试
  await page.unroute("**/api/file/**");
  await row.getByRole("button", { name: "重试" }).click();

  await waitRowStatus(page, "offline.bin", "已完成", 45_000);
  expect(await findProductFile(expectedMd5)).not.toBeNull();
});

test("VU-63-9 同会话内失败重试（S08）", async ({ page }) => {
  // 上传中途制造一次失败，再恢复重试
  await page.route("**/api/file/upload", (route) => void route.abort());

  const content = randContent(256 * 1024, "vu63-retry" + RUN_SALT);
  const expectedMd5 = md5(content);
  await uploadFiles(page, [fixture("retry.bin", content)]);

  const row = page.locator("tbody tr", {
    has: page.locator("td", { hasText: "retry.bin" }),
  });
  await waitRowStatus(page, "retry.bin", "上传失败", 20_000);

  await page.unroute("**/api/file/upload");
  await row.getByRole("button", { name: "重试" }).click();

  await waitRowStatus(page, "retry.bin", "已完成", 45_000);
  expect(await findProductFile(expectedMd5)).not.toBeNull();
});

test("VU-63-10 重复上传同一文件去重（S09 / VU-19）", async ({ page }) => {
  const content = randContent(32 * 1024, "vu63-dedupe" + RUN_SALT);
  const expectedMd5 = md5(content);
  // 显式指定 lastModified，确保两次选择的去重键（hash|size|lastModified|name）完全一致
  const file = {
    name: "dedupe.bin",
    mimeType: "application/octet-stream",
    buffer: content,
    lastModified: 1700000000000,
  };

  // 首次上传
  await uploadFiles(page, [file]);
  await waitRowStatus(page, "dedupe.bin", "已完成", 30_000);
  expect(await findProductFile(expectedMd5)).not.toBeNull();

  // 再次选择完全相同的文件（同名 + 同内容 + 同大小 + 同 lastModified）
  await uploadFiles(page, [file]);

  // 去重生效：列表里只有 1 行，且终态必须为「已完成」。同 key（hash|size|mtime|name）
  // 二次选择会被前端去重合并进首传那条已「已完成」的记录，而非另起一行「秒传成功」——
  // 这是确定性契约，T-50 不再用 .or() 放宽；一旦回退成独立的「秒传成功」行或记录数≠1，
  // 本断言会精确变红。
  const row = page.locator("tbody tr", {
    has: page.locator("td", { hasText: "dedupe.bin" }),
  });
  await expect(row).toHaveCount(1, { timeout: 10_000 });
  await waitRowStatus(page, "dedupe.bin", "已完成", 20_000);
});

/**
 * 批次详情抽屉里的整批「取消上传」：验证取消后每一行都能恢复续传。
 *
 * 断言的当前契约：
 * - 取消 → 所有在飞行立即落定为「已暂停」（速率归零、记录保留、分片缓存保留）；
 * - 点「继续」可续传至产物就绪。
 *
 * 之所以同时锁住「状态收尾」和「缓存保留」：Worker 卡在长同步哈希/合并等待时
 * 收不到 cancel，任务 Promise 不 settle 会让行永久停在 100%；而清空非终态记录的
 * 分片缓存会让「继续/重试」失去字节来源，刷新后直接判缓存缺失。
 */
test("VU-63-11 F-01/F-02 整批「取消上传」后不留「上传中」死行，可继续完成", async ({
  page,
}) => {
  // 整批取消入口在批次详情抽屉里，只有 full 模式才渲染 BatchInfoDisplay
  await page.goto("/e2e-full.html");
  await expect(fileInput(page)).toBeAttached();

  const specs = [
    { name: "batch-cancel-a.bin", seed: "vu63-batchcancel-a" + RUN_SALT },
    { name: "batch-cancel-b.bin", seed: "vu63-batchcancel-b" + RUN_SALT },
  ];
  const files = specs.map((s) => {
    const content = randContent(3 * 1024 * 1024, s.seed);
    return { ...fixture(s.name, content), _md5: md5(content) };
  });

  // 只用「延迟」而不置位 abort 闸口：取消本身就会终止 Worker，
  // 若再用 route.abort 制造分片失败，worker 可能先上报网络错误，把用例
  // 变成「取消 vs 网络失败」的竞态，测不到「取消落定 PAUSED」这条断言。
  const { handler } = makeUploadGate(2_000);
  await page.route("**/api/file/upload", handler);

  await uploadFiles(page, files);
  for (const f of files) {
    await waitRowStatus(page, f.name, "上传中", 20_000);
  }

  // 打开抽屉 → 整批取消
  await page.getByRole("button", { name: "详情" }).click();
  const cancelBtn = page.getByRole("button", { name: "取消上传" });
  await expect(cancelBtn).toBeVisible({ timeout: 10_000 });
  await cancelBtn.click();

  // F-01：两行都必须落定为「已暂停」，且不再有任何行显示「上传中」
  for (const f of files) {
    await waitRowStatus(page, f.name, "已暂停", 15_000);
    await expect(
      page.locator("tbody tr", { has: page.locator("td", { hasText: f.name }) })
    ).toHaveCount(1);
  }
  await expect(page.locator("tbody").getByText("上传中", { exact: true })).toHaveCount(
    0,
    { timeout: 10_000 }
  );

  // F-02：缓存未被清空 → 点「继续」可续传至终态（无需重新选择文件）
  await page.unroute("**/api/file/upload");
  const rowA = page.locator("tbody tr", {
    has: page.locator("td", { hasText: "batch-cancel-a.bin" }),
  });
  await rowA.getByRole("button", { name: "继续" }).click();
  await expect(
    rowA.getByText("已完成", { exact: true }).or(
      rowA.getByText("秒传成功", { exact: true })
    )
  ).toBeVisible({ timeout: 45_000 });
  expect(await findProductFile(files[0]._md5)).not.toBeNull();
});
