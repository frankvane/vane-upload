import { test, expect, type Page } from "@playwright/test";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { E2E_UPLOADS_DIR } from "./e2e-paths";

/**
 * T-49：secure 模式 E2E（由 `playwright.secure.config.ts` 驱动，独立 secure 后端）。
 *  - VU-63-16 secure 冒烟：带 `Authorization: Bearer` 头上传成功并产出 md5 一致产物。
 *  - VU-63-17 token 过期/轮换：运行时把前端令牌改成错误值 → 401 → 上传失败；
 *    改回正确令牌 → 重试 → 已完成。证明「鉴权失败可恢复」且 secure 链路真实依赖鉴权头。
 *
 * 变异自查锚点：把 `resolveAuthHeaders` 的 Bearer 拼接改坏（返回空头/错误 scheme），
 * 本 spec 的 VU-63-16 会因 401 必红——这是 T-49 要求的「改坏 auth 头拼接 → 至少 1 条红」。
 */

const UPLOADS_DIR = E2E_UPLOADS_DIR;
const SECURE_TOKEN = "e2e-secure-token";

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

/** 把前端注入的令牌改成指定值（getAuthToken 在请求时实时读取全局） */
async function setToken(page: Page, token: string): Promise<void> {
  await page.evaluate((t) => {
    (window as unknown as { __E2E_TOKEN__: string }).__E2E_TOKEN__ = t;
  }, token);
}

test.beforeEach(async ({ page }) => {
  await page.goto("/e2e-secure.html");
  await expect(fileInput(page)).toBeAttached();
});

test("VU-63-16 secure 冒烟：带鉴权头上传成功，产物 md5 一致", async ({
  page,
}) => {
  const content = randContent(256 * 1024, "vu63-secure-smoke" + RUN_SALT);
  const expectedMd5 = md5(content);
  const file = fixture("secure-smoke.bin", content);

  // 默认令牌即正确值（e2e-secure-main 的 fallback），直接上传
  await uploadFiles(page, [file]);
  await waitRowStatus(page, "secure-smoke.bin", "已完成");

  expect(
    await findProductFile(expectedMd5),
    "secure 模式下带鉴权头上传的产物 md5 应与源文件一致",
  ).not.toBeNull();
});

test("VU-63-17 token 过期/轮换：错误令牌 → 401 → 上传失败；改回正确令牌 → 重试成功", async ({
  page,
}) => {
  const content = randContent(256 * 1024, "vu63-secure-token" + RUN_SALT);
  const expectedMd5 = md5(content);
  const file = fixture("secure-token.bin", content);

  // 先把前端令牌改成错误值，模拟「令牌过期/被吊销」
  await setToken(page, "wrong-expired-token");

  await uploadFiles(page, [file]);
  // secure 后端对无/错凭据一律 401 → 上传失败（含重试耗尽后的终态）
  await waitRowStatus(page, "secure-token.bin", "上传失败", 30_000);

  // 模拟「刷新令牌」：改回正确令牌后重试
  await setToken(page, SECURE_TOKEN);
  const row = page.locator("tbody tr", {
    has: page.locator("td", { hasText: "secure-token.bin" }),
  });
  await row.getByRole("button", { name: "重试" }).click();

  await waitRowStatus(page, "secure-token.bin", "已完成", 45_000);
  expect(
    await findProductFile(expectedMd5),
    "令牌恢复后重试上传的产物 md5 应与源文件一致",
  ).not.toBeNull();
});
