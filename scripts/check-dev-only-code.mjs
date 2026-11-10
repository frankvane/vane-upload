// Build-output gate for dev-only diagnostics.
//
// `IS_DEV` is inlined to false in production builds, so the static-authToken
// warning branch (including its message) must be tree-shaken away. If anyone
// makes the warning unconditional, this check turns the CI build red instead of
// silently shipping a console.warn to every consumer.
//
// Run after:  npm run build
// Standalone: npm run check:dev-only

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIRS = ["dist/lib", "dist/demo"];
const MARKER = "[vane-upload][dev-only]";
const SCAN_EXT = new Set([".js", ".cjs", ".mjs"]);

function collectJsFiles(dir) {
  const found = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...collectJsFiles(full));
    } else if (SCAN_EXT.has(path.extname(entry.name))) {
      found.push(full);
    }
  }
  return found;
}

const missing = OUT_DIRS.filter((dir) => !fs.existsSync(path.join(ROOT, dir)));
if (missing.length > 0) {
  console.error(`✗ 缺少构建产物 ${missing.join(", ")}；请先执行 npm run build`);
  process.exit(1);
}

let scanned = 0;
const hits = [];
for (const dir of OUT_DIRS) {
  for (const file of collectJsFiles(path.join(ROOT, dir))) {
    scanned += 1;
    if (fs.readFileSync(file, "utf8").includes(MARKER)) {
      hits.push(path.relative(ROOT, file));
    }
  }
}

if (hits.length > 0) {
  console.error(
    `✗ 开发期告警文案出现在生产产物中（${hits.length} 个文件）：\n  ${hits.join("\n  ")}\n` +
      "  请确认告警分支仍由 IS_DEV / import.meta.env.DEV 守护，且未被静态引入。"
  );
  process.exit(1);
}

console.log(
  `✓ dev-only 告警未进入发布产物（扫描 ${OUT_DIRS.join(" + ")} 共 ${scanned} 个 JS 文件）`
);
