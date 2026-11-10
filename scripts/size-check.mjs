// Zero-dependency bundle size gate for the published library artifact.
//
// Measures the gzip size of the library ENTRY points under dist/lib and fails
// if any exceeds SIZE_LIMIT_KB (default 90). The demo app (dist/assets) and the
// server workspace package are intentionally excluded — they are NOT published
// to npm (see package.json `files: ["dist/lib"]` and `exports`), so they must
// not count against the library's size budget.
//
// Run after build:  npm run build:lib && node scripts/size-check.mjs
// Override limit:   SIZE_LIMIT_KB=120 node scripts/size-check.mjs

import { gzipSync } from "node:zlib";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const LIMIT_KB = Number(process.env.SIZE_LIMIT_KB ?? "90");
const LIMIT_BYTES = LIMIT_KB * 1024;

// Only the published entry points matter — these are what a consumer receives.
const ENTRIES = [
  { label: "ESM entry  (dist/lib/index.js)",  file: "dist/lib/index.js" },
  { label: "CJS entry  (dist/lib/index.cjs)", file: "dist/lib/index.cjs" },
];

/**
 * 陈旧产物守卫（T-11 的配套项）。
 *
 * 背景：曾出现过「门禁读数来自 11-08 的旧产物、当时代码还没加新功能」，
 * 于是体积基线比真实值小 2KB，且无人察觉——数字看着合理，其实测的不是当前源码。
 * emptyOutDir 只能保证不堆积，保证不了「你测的是刚构建出来的」。
 * 这里直接比对入口 mtime 与 src/ 下最新源文件：产物更旧就直接失败。
 */
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

const staleEntries = [];
for (const { label, file } of ENTRIES) {
  const abs = path.join(ROOT, file);
  if (!existsSync(abs)) continue;
  if (statSync(abs).mtimeMs < newestSourceMtime) {
    staleEntries.push({ label, abs });
  }
}
if (staleEntries.length > 0) {
  console.error(
    "\n[FAIL] 产物比源码旧，拒绝按陈旧产物判定体积（先跑 npm run build:lib）："
  );
  for (const { label, abs } of staleEntries) {
    console.error(
      `  - ${label}  ${new Date(statSync(abs).mtimeMs).toISOString()}`
    );
  }
  console.error(
    `  最新源文件：${new Date(newestSourceMtime).toISOString()}\n`
  );
  process.exit(1);
}

console.log(
  `\nLibrary size gate — limit ${LIMIT_KB} KB gzip per entry ` +
    `(excludes demo dist/assets and server)\n`
);

let failed = false;
for (const { label, file } of ENTRIES) {
  const abs = path.join(ROOT, file);
  if (!existsSync(abs)) {
    console.log(`  [MISSING] ${label}  (run "npm run build:lib" first)`);
    failed = true;
    continue;
  }
  const buf = readFileSync(abs);
  const raw = buf.length;
  const gzip = gzipSync(buf).length;
  const ok = gzip <= LIMIT_BYTES;
  if (!ok) failed = true;
  const flag = ok ? "[OK]  " : "[FAIL]";
  console.log(
    `  ${flag} ${label.padEnd(34)} raw ${(raw / 1024).toFixed(1)}KB  gzip ${(
      gzip / 1024
    ).toFixed(2)}KB`
  );
}

console.log(`\n  limit: ${LIMIT_KB}KB gzip per entry`);

if (failed) {
  console.error(
    `\n[FAIL] Size gate failed — a published entry exceeds ${LIMIT_KB}KB gzip.\n`
  );
  process.exit(1);
}

console.log(`\n[OK] Size gate passed — all published entries within ${LIMIT_KB}KB gzip.\n`);
