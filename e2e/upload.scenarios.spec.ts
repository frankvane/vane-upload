import { test, expect, type Page, type Route } from "@playwright/test";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { E2E_UPLOADS_DIR } from "./e2e-paths";

/**
 * T-49 场景补测（demo 模式，跑在既有 demo 后端上，无需独立 auth 配置）：
 *  - VU-63-12 网络离线切换：上传中 `context.setOffline(true)` → 上传失败；恢复后重试 → 已完成
 *  - VU-63-13 多 tab 同队列：一个 tab 进行中的任务，同源另一 tab 可见（IndexedDB 持久化跨 tab 共享）
 *  - VU-63-14 并发选 5 文件：全部完成且产物 md5 一致（fileConcurrency=2 压力）
 *  - VU-63-15 超大文件：小限制入口（maxFileSize=1MB）下 2MB 文件在选择阶段被拦截，
 *    不进列表、不发任何 /api/file 请求
 *
 * 复用 upload.smoke.spec.ts 的辅助函数（保持各 spec 自包含，便于单独调试）。
 */

const UPLOADS_DIR = E2E_UPLOADS_DIR;

const RUN_SALT =
  Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

function makeUploadGate(delayMs = 8000) {
  const gate = { paused: false };
  let chunkSeq = 0;
  const safeAbort = (route: Route) => {
    route.abort().catch(() => {});
  };
  const safeContinue = (route: Route) => {
    route.continue().catch(() => {});
  };
  const handler = (route: Route): void => {
    chunkSeq += 1;
    const n = chunkSeq;
    if (n >= 2 && gate.paused) {
      safeAbort(route);
      return;
    }
    if (n >= 2) {
      void sleep(delayMs).then(() => {
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
  await expect(fileInput(page)).toBeAttached();
});

test("VU-63-12 网络离线切换：上传中离线 → 上传失败，恢复后重试 → 已完成", async ({
  page,
}) => {
  const content = randContent(256 * 1024, "vu63-offline-switch" + RUN_SALT);
  const expectedMd5 = md5(content);
  const file = fixture("offline-switch.bin", content);

  // 用长延迟闸口把上传卡在「上传中」，确保离线发生在在途请求上
  const { gate, handler } = makeUploadGate(8_000);
  await page.route("**/api/file/upload", handler);

  await uploadFiles(page, [file]);
  await waitRowStatus(page, "offline-switch.bin", "上传中", 20_000);

  // 浏览器级离线：在途分片请求直接网络失败
  await page.context().setOffline(true);
  await waitRowStatus(page, "offline-switch.bin", "上传失败", 20_000);

  // 恢复网络并显式重试
  await page.context().setOffline(false);
  await page.unroute("**/api/file/upload");
  const row = page.locator("tbody tr", {
    has: page.locator("td", { hasText: "offline-switch.bin" }),
  });
  await row.getByRole("button", { name: "重试" }).click();

  await waitRowStatus(page, "offline-switch.bin", "已完成", 45_000);
  expect(await findProductFile(expectedMd5)).not.toBeNull();
});

test("VU-63-13 多 tab 同队列：一个 tab 进行中的任务，同源另一 tab 可见", async ({
  page,
  context,
}) => {
  const content = randContent(2 * 1024 * 1024, "vu63-multitab" + RUN_SALT);
  const file = fixture("multitab.bin", content);

  // tab1：上传进行中（长延迟闸口卡住），任务已持久化到 IndexedDB
  const { handler } = makeUploadGate(30_000);
  await page.route("**/api/file/upload", handler);
  await uploadFiles(page, [file]);
  await waitRowStatus(page, "multitab.bin", "上传中", 20_000);

  // tab2：同源新页，应从 IndexedDB 恢复出同一进行中记录（跨 tab 共享队列）
  const page2 = await context.newPage();
  await page2.goto("/e2e.html");
  await expect(fileInput(page2)).toBeAttached();

  await expect(
    page2.locator("tbody tr", {
      has: page2.locator("td", { hasText: "multitab.bin" }),
    }),
  ).toBeVisible({ timeout: 20_000 });

  // 清理：解除闸口并关掉 tab2，避免遗留悬挂的延迟请求
  await page.unroute("**/api/file/upload");
  await page2.close();
});

test("VU-63-14 并发选 5 文件全部完成且产物 md5 一致", async ({ page }) => {
  const specs = [
    { name: "conc-a.bin", size: 512 * 1024, seed: "vu63-conc-a" },
    { name: "conc-b.bin", size: 1024 * 1024, seed: "vu63-conc-b" },
    { name: "conc-c.bin", size: 1536 * 1024, seed: "vu63-conc-c" },
    { name: "conc-d.bin", size: 768 * 1024, seed: "vu63-conc-d" },
    { name: "conc-e.bin", size: 1280 * 1024, seed: "vu63-conc-e" },
  ];
  const files = specs.map((s) => {
    const content = randContent(s.size, s.seed + RUN_SALT);
    return { ...fixture(s.name, content), _md5: md5(content) };
  });

  await uploadFiles(page, files);

  for (const f of files) {
    await waitRowStatus(page, f.name, "已完成");
  }
  for (const f of files) {
    expect(
      await findProductFile(f._md5),
      `并发产物 ${f.name} 的 md5 应与源文件一致`,
    ).not.toBeNull();
  }
});

test("VU-63-15 超大文件（1MB 限制入口）选择阶段拦截，不进列表、不发分片请求", async ({
  page,
}) => {
  await page.goto("/e2e-smalllimit.html");
  await expect(fileInput(page)).toBeAttached();

  const apiHits: string[] = [];
  await page.route("**/api/file/**", (route) => {
    apiHits.push(route.request().url());
    void route.continue();
  });

  // 2MB > 入口 maxFileSize(1MB)，应在选择阶段被拦截
  await uploadFiles(page, [
    fixture("oversized.bin", randContent(2 * 1024 * 1024, "vu63-oversized" + RUN_SALT)),
  ]);

  await expect(
    page.getByText(/大小超过限制/),
  ).toBeVisible({ timeout: 10_000 });

  await sleep(800);
  await page.unroute("**/api/file/**");

  // 列表里不应出现该文件行
  await expect(
    page.locator("tbody tr", { has: page.locator("td", { hasText: "oversized.bin" }) }),
  ).toHaveCount(0);
  expect(apiHits.length, "超大文件不应触发任何 /api/file 请求").toBe(0);
});
