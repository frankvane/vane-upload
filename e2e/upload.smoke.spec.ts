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

/** 从第二个分片起延迟，制造「上传中」稳定窗口，便于暂停/取消；首个分片已落盘，续传可完成。 */
function installUploadDelay(route: Route): void {
  // @ts-expect-error 闭包计数挂在 route 对象上
  route._n = (route._n ?? 0) + 1;
  // @ts-expect-error 复用同一闭包计数，route 无 _n 类型声明
  const n = route._n as number;
  if (n >= 2) {
    // 让第 2 个及之后的分片请求挂起，留出暂停/取消窗口；首个分片已落盘
    void sleep(2500).then(() => {
      try {
        route.continue();
      } catch {
        /* 已被暂停中止的请求，忽略 */
      }
    });
  } else {
    try {
      route.continue();
    } catch {
      /* noop */
    }
  }
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

  // 再以不同文件名上传相同内容 → 后端命中 md5+size → 秒传
  await uploadFiles(page, [fixture("dup.bin", content)]);
  await waitRowStatus(page, "dup.bin", "秒传成功");

  // 秒传不产生新合并产物，但既有产物 md5 仍与源一致
  expect(await findProductFile(expectedMd5)).not.toBeNull();
});

test("VU-63-3 暂停后继续并完成，产物 md5 一致", async ({ page }) => {
  const content = randContent(3 * 1024 * 1024, "vu63-pause" + RUN_SALT);
  const expectedMd5 = md5(content);
  const file = fixture("pause-spec.bin", content);

  await page.route("**/api/file/upload", installUploadDelay);

  await uploadFiles(page, [file]);
  await waitRowStatus(page, "pause-spec.bin", "上传中", 20_000);

  const row = page.locator("tbody tr", {
    has: page.locator("td", { hasText: "pause-spec.bin" }),
  });
  await row.getByRole("button", { name: "暂停" }).click();
  await waitRowStatus(page, "pause-spec.bin", "已暂停", 10_000);

  await page.unroute("**/api/file/upload");
  await row.getByRole("button", { name: "继续" }).click();

  await waitRowStatus(page, "pause-spec.bin", "已完成", 45_000);
  expect(await findProductFile(expectedMd5)).not.toBeNull();
});

test("VU-63-4 取消上传后无合并产物", async ({ page }) => {
  const content = randContent(3 * 1024 * 1024, "vu63-cancel" + RUN_SALT);
  const expectedMd5 = md5(content);
  const file = fixture("cancel-spec.bin", content);

  await page.route("**/api/file/upload", installUploadDelay);

  await uploadFiles(page, [file]);
  await waitRowStatus(page, "cancel-spec.bin", "上传中", 20_000);

  const row = page.locator("tbody tr", {
    has: page.locator("td", { hasText: "cancel-spec.bin" }),
  });
  await row.getByRole("button", { name: "暂停" }).click();
  await waitRowStatus(page, "cancel-spec.bin", "已暂停", 10_000);
  // 已暂停时删除按钮可用（上传中不禁用），点击取消
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

  await page.route("**/api/file/upload", installUploadDelay);

  await uploadFiles(page, [fixture("resume-spec.bin", content)]);
  await waitRowStatus(page, "resume-spec.bin", "上传中", 20_000);

  const row = page.locator("tbody tr", {
    has: page.locator("td", { hasText: "resume-spec.bin" }),
  });
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
