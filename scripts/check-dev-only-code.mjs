// Build-output gate for dev-only diagnostics.
//
// `IS_DEV` is inlined to false in production builds, so the static-authToken
// warning branch (including its message) must be tree-shaken away. If anyone
// makes the warning unconditional, this check turns the CI build red instead of
// silently shipping a console.warn to every consumer.
//
// T-47（语义扫描，替代脆弱的连续 MARKER 子串匹配）：
//   - 旧实现只查连续的 "[vane-upload][dev-only]" 字面量；把告警文案拆成字符串拼接
//     （产物仍含 console.warn 但不再含连续 MARKER）即可绕过。
//   - 新实现逐调用点扫描 `console.warn(...)`：库产物里**唯一合法**的 console.warn
//     来自 debugLogger（参数必带前缀 "[rui-upload]" 且运行时由 silent 守卫）；
//     dev-only 告警参数从不含 "[rui-upload]"。因此「console.warn 且参数不含
//     [rui-upload]」即判定为 dev-only 告警泄漏——无论其文案是否被拆分。
//   - 同时保留连续 MARKER 子串作为兜底（防未拆分情形）。
//   - 扫描整个 dist（lib + demo），覆盖 .js/.cjs/.mjs/.html。
//
// Run after:  npm run build
// Standalone: npm run check:dev-only

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// 只严查 dist/lib（npm 发布产物，package.json `files: ["dist/lib"]`）。dist/demo 不发布，
// 且会打包第三方依赖（如 localforage 自身的 console.warn），对 demo 只做连续 MARKER
// 兜底检查，避免把依赖的 console.warn 误判为 dev-only 泄漏。
const STRICT_DIRS = ["dist/lib"];
const MARKER_DIRS = ["dist/lib", "dist/demo"];
const MARKER = "[vane-upload][dev-only]";
const LEGIT_WARN_TAG = "[rui-upload]"; // debugLogger 的 warn/error 前缀，运行时 guarded
const SCAN_EXT = new Set([".js", ".cjs", ".mjs", ".html"]);

function collectFiles(dir) {
  const found = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...collectFiles(full));
    } else if (SCAN_EXT.has(path.extname(entry.name))) {
      found.push(full);
    }
  }
  return found;
}

const allDirs = [...new Set([...STRICT_DIRS, ...MARKER_DIRS])];
const missing = allDirs.filter((dir) => !fs.existsSync(path.join(ROOT, dir)));
if (missing.length > 0) {
  console.error(`✗ 缺少构建产物 ${missing.join(", ")}；请先执行 npm run build`);
  process.exit(1);
}

/**
 * 从 content 的 `start`（指向 `console.warn(` 中 `(` 之后）开始，扫描到匹配的右括号，
 * 返回该调用实参区的文本。支持成对的 ()[]{} 与字符串字面量（忽略其中的括号）。
 */
function callArgsSlice(content, start) {
  let i = start;
  let depth = 1;
  let inStr = null;
  for (; i < content.length; i += 1) {
    const ch = content[i];
    if (inStr) {
      if (ch === "\\") {
        i += 1;
        continue;
      }
      if (ch === inStr) inStr = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      inStr = ch;
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{") depth += 1;
    else if (ch === ")" || ch === "]" || ch === "}") {
      depth -= 1;
      if (depth === 0) return content.slice(start, i);
    }
  }
  return content.slice(start, i);
}

let scanned = 0;
const hits = [];
const scanDir = (dir, strict) => {
  for (const file of collectFiles(path.join(ROOT, dir))) {
    scanned += 1;
    const content = fs.readFileSync(file, "utf8");
    const rel = path.relative(ROOT, file);

    // 兜底：连续 MARKER 字面量（未拆分情形），lib 与 demo 都查。
    if (content.includes(MARKER)) {
      hits.push(`${rel}: 连续 dev-only 标记字面量 "[vane-upload][dev-only]"`);
      continue;
    }

    // 语义（仅严格目录 dist/lib）：逐调用点找 console.warn(...)，参数区不含合法
    // [rui-upload] 前缀 → dev-only 告警泄漏。demo 不查语义，因其打包了 localforage
    // 等含 console.warn 的第三方依赖。
    if (!strict) continue;
    const re = /console\s*\.\s*warn\s*\(/g;
    let m;
    while ((m = re.exec(content)) !== null) {
      const args = callArgsSlice(content, m.index + m[0].length);
      if (!args.includes(LEGIT_WARN_TAG)) {
        hits.push(
          `${rel}: 非 debugLogger 的 console.warn（参数不含 "${LEGIT_WARN_TAG}"）—— dev-only 告警疑似泄漏`
        );
        break; // 同文件不再重复记录
      }
    }
  }
};
for (const dir of STRICT_DIRS) scanDir(dir, true);
for (const dir of MARKER_DIRS) if (!STRICT_DIRS.includes(dir)) scanDir(dir, false);

if (hits.length > 0) {
  console.error(
    `✗ 开发期告警疑似进入生产产物（${hits.length} 处）：\n  ${hits.join("\n  ")}\n` +
      "  请确认告警分支仍由 IS_DEV / import.meta.env.DEV 守护，且未被静态拆分绕过。"
  );
  process.exit(1);
}

console.log(
  `✓ dev-only 告警未进入发布产物（扫描 ${allDirs.join(" + ")} 共 ${scanned} 个文件）`
);
