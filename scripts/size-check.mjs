// Zero-dependency bundle size gate for the published library artifact.
//
// Measures the gzip size of EVERY published file under dist/lib and fails if any
// FORMAT GROUP (ESM / CJS) or any ENTRY exceeds its budget.
//
// 为什么遍历全部产物（T-41 / D-06）：
//   package.json `files:["dist/lib"]` 确认 14 个 JS/CSS 全部发布，但 `exports`
//   的 import/require 只会加载其中**一组**。旧脚本只数 2 个入口、把 ESM+CJS 两套
//   动态 chunk 算成一份（98.24KB 双格式总量），既漏计 12 个 / 61.89KB、又把同一份
//   代码计两次。现按格式分组独立判定。
//
// 阈值口径（D-06 方案 A 修正）：
//   - 单格式组预算 SIZE_LIMIT_FORMAT_KB = 65（实测 ESM≈53.8 / CJS≈49.0，余量 ~21%/33%）
//   - 单入口预算 SIZE_LIMIT_KB = 40（实测 index.js≈19.3 / index.cjs≈17.0）
//
// 阈值禁止环境变量改写（T-48）：阈值写死于此受版本控制的脚本；检测到外部改写
// 直接报错退出，消除「CI 可绕过设计口子」这类静默放行。
//   SIZE_LIMIT_KB=9999 npm run size:check  → exit 1
//
// 陈旧产物守卫（T-11 配套）：比对产物 mtime 与 src/ 最新源文件，产物更旧即失败。

import { gzipSync } from "node:zlib";
import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const LIB_DIR = path.join(ROOT, "dist", "lib");

// ---- T-48：阈值写死，禁止 env 改写 -------------------------------------------
for (const envVar of ["SIZE_LIMIT_KB", "SIZE_LIMIT_FORMAT_KB"]) {
  if (process.env[envVar] !== undefined) {
    console.error(
      `\n[FAIL] 体积阈值 ${envVar} 不允许通过环境变量改写（它是受版本控制的` +
        ` 设计常量，写死于 scripts/size-check.mjs）。\n` +
        `  检测到 ${envVar}=${JSON.stringify(process.env[envVar])} → 直接失败，` +
        ` 防止 CI 被绕过。\n`
    );
    process.exit(1);
  }
}

// 设计常量（非 env 可改）。改这里前先同步 docs/TODO实施清单-2026-11-10-第二轮.md §9。
const SIZE_LIMIT_FORMAT_KB = 65; // 单格式组（ESM 或 CJS 全部文件之和，含 CSS）
const SIZE_LIMIT_KB = 40; // 单入口（index.js / index.cjs）

const LIMIT_FORMAT_BYTES = SIZE_LIMIT_FORMAT_KB * 1024;
const LIMIT_ENTRY_BYTES = SIZE_LIMIT_KB * 1024;

// ---- 陈旧产物守卫：比对全部产物 mtime 与 src/ 最新源文件 ----------------------
const newestSourceMtime = (() => {
  let newest = 0;
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(abs);
        continue;
      }
      if (!/\.(ts|tsx|css)$/.test(entry.name)) continue;
      if (entry.name.includes(".test.")) continue;
      newest = Math.max(newest, statSync(abs).mtimeMs);
    }
  };
  walk(path.join(ROOT, "src"));
  return newest;
})();

// ---- 收集 dist/lib 全部发布产物 ----------------------------------------------
function collectFiles(dir) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...collectFiles(abs));
      continue;
    }
    if (/\.(js|cjs|css)$/.test(entry.name)) found.push(abs);
  }
  return found;
}

if (!existsSync(LIB_DIR)) {
  console.error(`\n[FAIL] 缺少库产物 dist/lib；请先执行 npm run build:lib\n`);
  process.exit(1);
}

const allFiles = collectFiles(LIB_DIR);

// 陈旧守卫覆盖每一个产物（T-41：扩展到全部文件，不再只看入口）
const stale = [];
for (const abs of allFiles) {
  if (statSync(abs).mtimeMs < newestSourceMtime) stale.push(abs);
}
if (stale.length > 0) {
  console.error(
    "\n[FAIL] 产物比源码旧，拒绝按陈旧产物判定体积（先跑 npm run build:lib）："
  );
  for (const abs of stale) {
    console.error(`  - ${path.relative(ROOT, abs)}  ${new Date(statSync(abs).mtimeMs).toISOString()}`);
  }
  console.error(`  最新源文件：${new Date(newestSourceMtime).toISOString()}\n`);
  process.exit(1);
}

// ---- 按格式分组（ESM: .js + CSS；CJS: .cjs + CSS；CSS 两组各计一次）-----------
const groups = {
  ESM: { label: "ESM group", files: [], bytes: 0 },
  CJS: { label: "CJS group", files: [], bytes: 0 },
};
const cssBytes = (() => {
  let total = 0;
  for (const abs of allFiles) {
    if (abs.endsWith(".css")) total += gzipSync(readFileSync(abs)).length;
  }
  return total;
})();

const entries = [];
for (const abs of allFiles) {
  const gz = gzipSync(readFileSync(abs)).length;
  const rel = path.relative(ROOT, abs);
  if (abs.endsWith(".css")) continue; // CSS 已在 cssBytes 汇总，不重复入组
  if (abs.endsWith(".js")) {
    groups.ESM.files.push({ rel, gz });
    groups.ESM.bytes += gz;
  } else if (abs.endsWith(".cjs")) {
    groups.CJS.files.push({ rel, gz });
    groups.CJS.bytes += gz;
  }
  if (/index\.(js|cjs)$/.test(abs)) {
    entries.push({ rel, gz });
  }
}
groups.ESM.bytes += cssBytes;
groups.CJS.bytes += cssBytes;

console.log(
  `\nLibrary size gate — format group limit ${SIZE_LIMIT_FORMAT_KB}KB gzip, ` +
    `entry limit ${SIZE_LIMIT_KB}KB gzip`
);
console.log(`  scanned ${allFiles.length} published files under dist/lib\n`);

let failed = false;
for (const key of ["ESM", "CJS"]) {
  const g = groups[key];
  const ok = g.bytes <= LIMIT_FORMAT_BYTES;
  if (!ok) failed = true;
  const flag = ok ? "[OK]  " : "[FAIL]";
  console.log(
    `  ${flag} ${g.label.padEnd(10)} total ${(g.bytes / 1024).toFixed(2)}KB ` +
      `(limit ${SIZE_LIMIT_FORMAT_KB}KB)  [+CSS ${(cssBytes / 1024).toFixed(2)}KB]`
  );
}
for (const e of entries) {
  const ok = e.gz <= LIMIT_ENTRY_BYTES;
  if (!ok) failed = true;
  const flag = ok ? "[OK]  " : "[FAIL]";
  console.log(
    `  ${flag} entry ${e.rel.padEnd(28)} gzip ${(e.gz / 1024).toFixed(2)}KB ` +
      `(limit ${SIZE_LIMIT_KB}KB)`
  );
}

if (failed) {
  console.error(
    `\n[FAIL] Size gate failed — a published format group or entry exceeds budget.\n`
  );
  process.exit(1);
}

console.log(`\n[OK] Size gate passed — all format groups and entries within budget.\n`);
