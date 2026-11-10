// Node 版本前哨：把「静默退出码 9」变成一句能读懂的话。
//
// 为什么需要：后端覆盖率门禁用的是 `node --test --test-coverage-lines=90
// --test-coverage-branches=75 …`，其中 `--test-coverage-include/exclude`
// 自 v22.5.0、`--test-coverage-lines/branches/functions` 自 v22.8.0 才有。
// 在更早的 Node（例如 CI 原先钉的 20）上，这些 flag 被当作**未知启动参数**，
// Node 直接以退出码 9 退出且**不打印任何错误**——CI run #1 的失败现场就是
// 一行 "Process completed with exit code 9"，无从判断断在哪个阶段、为什么。
//
// 因此门禁前置本脚本：低于要求时明确报出「最低版本 / 当前版本 / 缺哪个 flag」。
//
// 用法：node scripts/check-node.mjs   （package.json 的 ci 与 server 的
// test:coverage 都会先跑它）
//
// 可覆盖阈值以便验证「低于版本时」的输出（本机很难装旧 Node）：
//   VANE_MIN_NODE=99 node scripts/check-node.mjs   → 应打印说明并以 1 退出

const MIN = process.env.VANE_MIN_NODE || "22.8.0";

const [major, minor, patch] = process.versions.node.split(".").map(Number);
const [minMajor, minMinor, minPatch] = MIN.split(".").map(Number);

const below =
  major < minMajor ||
  (major === minMajor && minor < minMinor) ||
  (major === minMajor && minor === minMinor && patch < minPatch);

if (!below) process.exit(0);

const hint =
  major < 22
    ? "该版本完全没有 --test-coverage-* 系列参数"
    : "该版本缺少 v22.8.0 引入的 --test-coverage-lines/branches/functions";

console.error(
  [
    "",
    `✗ 门禁要求 Node ≥ ${MIN}，当前 ${process.versions.node}（${hint}）。`,
    "",
    "  低版本不会给出任何错误提示：`node --test --test-coverage-lines=90` 里的",
    "  flag 会被当成未知启动参数，Node 以退出码 9 静默退出 —— 看起来像测试挂了，",
    "  实际是根本没跑。",
    "",
    "  处理：切到 Node 22+ 后重试（仓库根目录有 .nvmrc，可 `nvm use`）。",
    "",
  ].join("\n")
);
process.exit(1);
