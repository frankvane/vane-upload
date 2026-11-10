// 定点清理上一代构建产物。
//
// 不用 vite `emptyOutDir: true`：本仓库在 WorkBuddy 沙箱内构建，emptyDir 会递归
// 删除整个输出目录；`dist/lib` 下 tsc 产出的 .d.ts 目录树会越过平台批量删除
// 守卫阈值（50 个文件），使构建直接失败。
//
// 改为：构建前记录时间戳，构建后只删除「mtime 早于本次构建」的文件，
// 且不递归进入 .d.ts 目录树（由 tsc 覆盖写）。每次只删几个上一代 hashed chunk。
//
// 用法：
//   node scripts/prune-stale-assets.mjs stamp demo|lib   # 构建前
//   node scripts/prune-stale-assets.mjs prune demo|lib   # 构建后

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

/** 每个目标只清理「自己那一层」的文件，绝不递归。 */
const SCOPES = {
  demo: ["dist/demo/assets", "dist/demo"],
  lib: ["dist/lib"],
};

/** 单次删除上限：低于平台批量删除守卫阈值，留出余量。 */
const MAX_DELETE = 30;

/**
 * 只清理「带哈希后缀」的产物（`FileTable-DHAGAGu9.cjs`、`index-DTJ6tZKa.js` 这类）。
 *
 * 为什么不按「mtime 早于构建」一刀切：
 * `index.d.ts` / `index.js` / `style.css` 是固定文件名，永远不会堆积，但 tsc 在内容
 * 未变时可能跳过写入 —— 它们的 mtime 会早于本次构建，按时间戳就会被误删，
 * 结果是发出去的包缺声明文件。这类固定名产物由构建覆盖写，无需清理。
 * 会堆积的恰恰只有 hashed chunk，所以规则收窄到它们。
 */
const HASHED_ARTIFACT = /-[A-Za-z0-9_-]{6,}\.(?:js|cjs|css)$/;

const [command, target] = process.argv.slice(2);

if (!command || !target || !(target in SCOPES)) {
  console.error(
    "[prune] 用法：node scripts/prune-stale-assets.mjs <stamp|prune> <demo|lib>"
  );
  process.exit(2);
}

const stampFile = path.join(ROOT, "dist", `.build-stamp-${target}`);

if (command === "stamp") {
  mkdirSync(path.dirname(stampFile), { recursive: true });
  writeFileSync(stampFile, String(Date.now()));
  process.exit(0);
}

if (command !== "prune") {
  console.error(`[prune] 未知命令：${command}`);
  process.exit(2);
}

if (!existsSync(stampFile)) {
  // 没有戳说明构建前没跑 stamp（例如外部工具直接调 vite build），此时不做任何删除。
  console.log(`[prune] ${target}: 无构建戳，跳过清理`);
  process.exit(0);
}

const buildStartedAt = Number(readFileSync(stampFile, "utf8"));
const stale = [];

for (const rel of SCOPES[target]) {
  const dir = path.join(ROOT, rel);
  if (!existsSync(dir)) continue;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile()) continue; // 不碰目录（.d.ts 树由 tsc 覆盖写）
    if (entry.name.startsWith(".")) continue;
    if (!HASHED_ARTIFACT.test(entry.name)) continue; // 固定名产物不清理，见上方说明
    const abs = path.join(dir, entry.name);
    if (statSync(abs).mtimeMs < buildStartedAt) stale.push(abs);
  }
}

if (stale.length === 0) {
  console.log(`[prune] ${target}: 无上一代产物`);
  process.exit(0);
}

if (stale.length > MAX_DELETE) {
  console.error(
    `[prune] ${target}: 待删 ${stale.length} 个，超过单次上限 ${MAX_DELETE}。` +
      `\n  请在普通终端执行 rm -rf dist 后重建，避免撞平台批量删除守卫。`
  );
  process.exit(1);
}

for (const abs of stale) {
  unlinkSync(abs);
}
console.log(
  `[prune] ${target}: 删除 ${stale.length} 个上一代产物 —— ` +
    stale.map((abs) => path.basename(abs)).join(", ")
);
