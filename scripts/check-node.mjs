// Node 版本前哨：把「未知启动参数导致的静默退出码 9」变成一句能读懂的话。
//
// 后端覆盖率门禁用 `node --test --test-coverage-include/exclude`（≥22.5.0）与
// `--test-coverage-lines/branches/functions`（≥22.8.0）。更早的 Node 会把这些
// flag 当成非法启动参数，不打印错误、直接以 9 退出，CI 上无法定位。
// 因此 ci 与 server 的 test:coverage 都先跑本脚本，低于要求时明确报出
// 「最低版本 / 当前版本 / 缺哪个 flag」。
//
// 用法：node scripts/check-node.mjs
// 验证低版本分支：VANE_MIN_NODE=99 node scripts/check-node.mjs → 打印说明并以 1 退出

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
