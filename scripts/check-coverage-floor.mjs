// Per-file zero-coverage gate (T-42 / M5).
//
// `vite.config.ts` 已开 coverage.all:true —— 未被执行（未被 import）的源文件也会进入
// 报告。本脚本在 `npm run test:coverage` 产出 coverage-final.json 后，逐文件检查：任何
// `src/**` 运行时文件（含可执行语句）若**零覆盖**，即判定为「漏网的新增零测试模块」，
// 让 CI 变红。
//
// 为何不直接用 vite 的 perFile 阈值：perFile 会对**每个**文件套用全局阈值，会把历史
// 上部分低覆盖文件也判失败；本脚本只盯「彻底零覆盖」（total>0 且 covered=0），精确对齐
// M5 的变异「新增 200 行 0% 模块 → CI 红」，且不误伤部分覆盖的存量文件。
// 已知零测试模块已在 vite.config 的 exclude 中豁免（T-51 将逐步补测/收窄）。
//
// 读取路径与 vite 的 reportsDirectory 对齐（COVERAGE_OUT_DIR）。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const REPORT_DIR =
  process.env.VITE_COV_DIR || path.join(os.tmpdir(), "vane-upload-measure-out");
const JSON_PATH = path.join(REPORT_DIR, "coverage-final.json");

if (!fs.existsSync(JSON_PATH)) {
  console.error(`✗ 未找到覆盖率报告 ${JSON_PATH}；请先执行 npm run test:coverage`);
  process.exit(1);
}

const report = JSON.parse(fs.readFileSync(JSON_PATH, "utf8"));

// 这些目录/文件即便出现在报告里也不计为零覆盖（已被 vite exclude，双保险）。
const SKIP = [
  "/demo/",
  "/dev/",
  "/test/",
  "/mocks/",
  ".test.",
  ".test-d.",
  "/e2e-",
  "/index.ts",
];

const zeroCovered = [];
for (const abs of Object.keys(report)) {
  if (!abs.includes(path.sep + "src" + path.sep)) continue;
  if (SKIP.some((s) => abs.includes(s))) continue;

  const entry = report[abs];
  const stmts = entry.s;
  const total = Object.keys(stmts).length;
  if (total === 0) continue; // 纯类型/常量：无运行时语句，天然豁免
  const covered = Object.values(stmts).filter((n) => n > 0).length;
  if (covered === 0) {
    zeroCovered.push(path.relative(process.cwd(), abs).split(path.sep).join("/"));
  }
}

if (zeroCovered.length > 0) {
  console.error(
    `✗ 发现 ${zeroCovered.length} 个 src 运行时文件零覆盖（all:true 仍计入报告）：\n` +
      zeroCovered.map((f) => `  - ${f}`).join("\n") +
      `\n  请为这些模块补测试，或从 vite.config 的 exclude 中明确豁免并注明理由（T-51）。`
  );
  process.exit(1);
}

console.log(
  `✓ 逐文件零覆盖门禁通过（报告中 src 运行时文件均无「彻底零覆盖」）`
);
