import { test, expect, type Page } from "@playwright/test";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { E2E_UPLOADS_DIR } from "./e2e-paths";

/**
 * T-73 浏览器功能回归手册「缺口补全」E2E：用真实浏览器驱动真实 dev 应用（`/`），
 * 覆盖 `upload.smoke/scenarios` 未触达的 A 组配置/UI、B 组选择校验、C2 大文件、
 * E3/E4 重试与失败清理、F5 删除已完成。
 *
 * 复用 smoke spec 的 RANDOM 盐 + md5 产物校验思路，但本文件只跑 dev 应用（`/`），
 * 直接通过隐藏 file input 注入文件（与「测试注入口」等价，绕过原生文件框）。
 */

const UPLOADS_DIR = E2E_UPLOADS_DIR;

const RUN_SALT =
  Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);

function md5(buf: Buffer | string): string {
  return crypto.createHash("md5").update(buf).digest("hex");
}

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

const rowOf = (page: Page, fileName: string) =>
  page.locator("tbody tr", {
    has: page.locator("td", { hasText: fileName }),
  });

// 自动上传 / 自动清理 开关：外层 div 含文案 span，Switch 为其紧邻兄弟 button
const toggleSwitchAfter = (page: Page, label: string) =>
  page.locator(`span:has-text("${label}")`).locator("xpath=following-sibling::button");

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(fileInput(page)).toBeAttached();
});

test("GAP-A1 初始渲染：标题/工具栏/徽标/表头/空态", async ({ page }) => {
  await expect(page.getByRole("heading", { name: "上传组件演示" })).toBeVisible();
  await expect(page.getByRole("button", { name: "选择文件" })).toBeVisible();
  await expect(page.getByRole("button", { name: "上传文件" })).toBeVisible();
  await expect(page.getByRole("button", { name: "清除列表" })).toBeVisible();
  await expect(page.getByRole("button", { name: "批量重试" })).toBeVisible();
  // 网络徽标默认「4G」（tooltip 模式）
  await expect(page.getByText("4G").first()).toBeVisible();
  // 表头 7 列
  for (const h of ["编号", "文件名", "大小", "分片数", "状态", "进度", "操作"]) {
    await expect(page.locator("thead").getByText(h, { exact: true })).toBeVisible();
  }
  // 空态
  await expect(page.getByText("暂无数据")).toBeVisible();
});

test("GAP-A2 显示模式切换：简洁 ↔ 详细", async ({ page }) => {
  // 自定义 Switch：role=switch，未勾选内显「简洁」、勾选后内显「详细」，且唯一含该文案
  const dispSw = page.getByRole("switch", { name: "简洁" });
  await expect(dispSw).toBeVisible();
  // 默认 tooltip 模式：徽标仅「4G」，不含「MB |」明细（表头「文件名/分片数」不含此串）
  await expect(page.getByText(/MB\s*\|/).first()).toHaveCount(0);
  // 切到详细（直接显示）模式：徽标出现「MB | N文件 | N分片」
  await dispSw.click();
  await expect(page.getByText(/MB\s*\|/).first()).toBeVisible({ timeout: 5_000 });
  // 切回简洁
  await page.getByRole("switch", { name: "详细" }).click();
  await expect(page.getByText(/MB\s*\|/).first()).toHaveCount(0, { timeout: 5_000 });
});

test("GAP-A3+A4 关闭自动上传 → 排队中；点「上传文件」手动上传完成", async ({
  page,
}) => {
  const content = randContent(3 * 1024 * 1024, "gap-a34" + RUN_SALT);
  const expectedMd5 = md5(content);
  const file = fixture("gap-manual.bin", content);

  // 关闭自动上传
  await toggleSwitchAfter(page, "自动上传").click();
  await expect(toggleSwitchAfter(page, "自动上传")).toBeChecked({ checked: false });

  await uploadFiles(page, [file]);
  // 不自动开始 → 进入「排队中」
  await waitRowStatus(page, "gap-manual.bin", "排队中", 8_000);

  // 手动上传
  await page.getByRole("button", { name: "上传文件" }).click();
  await waitRowStatus(page, "gap-manual.bin", "已完成", 45_000);
  expect(await findProductFile(expectedMd5)).not.toBeNull();
});

test("GAP-A5 自动清理 + 延时：完成后记录被自动移除", async ({ page }) => {
  const content = randContent(512 * 1024, "gap-a5" + RUN_SALT);
  await uploadFiles(page, [fixture("gap-cleanup.bin", content)]);
  await waitRowStatus(page, "gap-cleanup.bin", "已完成", 30_000);
  // 默认 cleanupDelay=5s，自动清理开启 → 约 5s 后记录移除，回到空态
  await expect(
    rowOf(page, "gap-cleanup.bin"),
  ).toHaveCount(0, { timeout: 12_000 });
  await expect(page.getByText("暂无数据")).toBeVisible();
});

test("GAP-A6 存储统计抽屉：打开与关闭", async ({ page }) => {
  // 存储统计为纯图标按钮（BarChartOutlined），工具栏内唯一含 svg 的 rui-btn
  await page.locator("button.rui-btn").filter({ has: page.locator("svg") }).click();
  await expect(
    page.locator(".rui-drawer-header", { hasText: "存储统计" }),
  ).toBeVisible({ timeout: 5_000 });
  // 关闭抽屉（ESC）
  await page.keyboard.press("Escape");
  await expect(
    page.locator(".rui-drawer-header", { hasText: "存储统计" }),
  ).toHaveCount(0, { timeout: 5_000 });
});

test("GAP-B3 中文名 + 空格文件名正常上传完成", async ({ page }) => {
  const content = randContent(64 * 1024, "gap-b3" + RUN_SALT);
  const expectedMd5 = md5(content);
  await uploadFiles(page, [
    fixture("中文名称 空格 文档.txt", content),
  ]);
  await waitRowStatus(page, "中文名称 空格 文档.txt", "已完成", 30_000);
  expect(await findProductFile(expectedMd5)).not.toBeNull();
});

test("GAP-B4 自定义校验拦截：文件名含 test 被拒，列表不新增", async ({
  page,
}) => {
  await uploadFiles(page, [
    fixture("test-被拦截示例.txt", randContent(4 * 1024, "gap-b4" + RUN_SALT)),
  ]);
  await expect(
    page.getByText("文件名包含 test 时不允许上传"),
  ).toBeVisible({ timeout: 10_000 });
  await expect(
    rowOf(page, "test-被拦截示例.txt"),
  ).toHaveCount(0, { timeout: 5_000 });
});

test("GAP-B5 maxFiles=10 上限：超量整批拒绝", async ({ page }) => {
  const files = Array.from({ length: 11 }, (_, i) =>
    fixture(`gap-b5-${i}.bin`, randContent(64 * 1024, `gap-b5-${i}-${RUN_SALT}`)),
  );
  await uploadFiles(page, files);
  await expect(
    page.getByText(/最多只能选择 10 个文件/),
  ).toBeVisible({ timeout: 10_000 });
  // 列表不应出现任何被拒文件
  await expect(
    page.locator("tbody tr", { has: page.locator("td", { hasText: "gap-b5-0.bin" }) }),
  ).toHaveCount(0, { timeout: 5_000 });
});

test("GAP-B6 清除列表：列表清空回到空态", async ({ page }) => {
  await uploadFiles(page, [
    fixture("gap-b6.bin", randContent(512 * 1024, "gap-b6" + RUN_SALT)),
  ]);
  await expect(rowOf(page, "gap-b6.bin")).toHaveCount(1, { timeout: 8_000 });
  await page.getByRole("button", { name: "清除列表" }).click();
  await expect(page.getByText("暂无数据")).toBeVisible({ timeout: 5_000 });
});

test("GAP-C2 大文件（40MB 代理 95MB）多分片平滑上传至完成", async ({
  page,
}) => {
  test.setTimeout(180_000);
  // 关闭自动清理：40MB 在负载机上上传耗时接近测试超时，默认 cleanupDelay=5s 会把
  // 「已完成」记录自动移除，使断言窗口与清理窗口碰撞（同机负载波动假红）。回归手册也建议
  // 实测时先关掉自动清理，这里显式关闭以保证「已完成」行可被稳定断言。
  await toggleSwitchAfter(page, "自动清理").click();
  await expect(toggleSwitchAfter(page, "自动清理")).toBeChecked({
    checked: false,
  });

  // 用应用自带「测试注入口」的「3×40MB 队列」注入大文件（手册指定路径）。
  // 选用此按钮而非「自定义 MB」输入框 / 隐藏 input 的 setInputFiles：前者对 React 受控
  // number input 的 fill 偶发不生效、后者 40MB 内存 buffer 在负载机上偶发入队失败（空表），
  // 本按钮派发确定文件名（队列-1-40MB.bin）的 change 事件，最稳定。仅断言首个 40MB 文件
  // 到达终态，其余两个同样会上传、不影响判定。
  await page.getByRole("button", { name: "3×40MB 队列" }).click();
  await waitRowStatus(page, "队列-1-40MB.bin", "已完成", 150_000);

  // 服务端产物落地：uploads 目录下应出现一个恰好 40MB 的产物（内容随机 ⇒ 真实多分片上传）。
  const productReady = fs
    .readdirSync(UPLOADS_DIR)
    .some(
      (f) =>
        fs.statSync(path.join(UPLOADS_DIR, f)).size === 40 * 1024 * 1024,
    );
  expect(productReady).toBe(true);
});

test("GAP-E3 批量重试：多文件失败 → 批量重试全部完成", async ({ page }) => {
  await page.route("**/api/file/upload", (route) => void route.abort());
  const specs = [
    { name: "gap-e3-a.bin", seed: "gap-e3-a" + RUN_SALT },
    { name: "gap-e3-b.bin", seed: "gap-e3-b" + RUN_SALT },
  ];
  const files = specs.map((s) => ({
    ...fixture(s.name, randContent(256 * 1024, s.seed)),
    _md5: md5(randContent(256 * 1024, s.seed)),
  }));
  await uploadFiles(page, files);
  for (const f of files) {
    await waitRowStatus(page, f.name, "上传失败", 25_000);
  }
  // 批量重试按钮亮起（含失败计数）
  const batchRetry = page.getByRole("button", { name: /批量重试/ });
  await expect(batchRetry).toBeVisible();
  await page.unroute("**/api/file/upload");
  await batchRetry.click();
  for (const f of files) {
    await waitRowStatus(page, f.name, "已完成", 45_000);
  }
});

test("GAP-E4 删除失败记录：失败行删除后列表移除、批量重试计数归零", async ({
  page,
}) => {
  await page.route("**/api/file/upload", (route) => void route.abort());
  const content = randContent(256 * 1024, "gap-e4" + RUN_SALT);
  const file = fixture("gap-e4.bin", content);
  await uploadFiles(page, [file]);
  await waitRowStatus(page, "gap-e4.bin", "上传失败", 25_000);
  await page.unroute("**/api/file/upload");
  // 失败行点「删除」
  await rowOf(page, "gap-e4.bin").getByRole("button", { name: "删除" }).click();
  await expect(rowOf(page, "gap-e4.bin")).toHaveCount(0, { timeout: 8_000 });
  // 批量重试计数归零（恢复为无计数文案）
  await expect(page.getByRole("button", { name: "批量重试" })).toBeVisible();
  await expect(
    page.getByRole("button", { name: /批量重试 \(\d+\)/ }),
  ).toHaveCount(0, { timeout: 5_000 });
});

test("GAP-F5 删除已完成记录：完成后删除，记录移除", async ({ page }) => {
  const content = randContent(512 * 1024, "gap-f5" + RUN_SALT);
  await uploadFiles(page, [fixture("gap-f5.bin", content)]);
  await waitRowStatus(page, "gap-f5.bin", "已完成", 30_000);
  await rowOf(page, "gap-f5.bin").getByRole("button", { name: "删除" }).click();
  await expect(rowOf(page, "gap-f5.bin")).toHaveCount(0, { timeout: 8_000 });
});
