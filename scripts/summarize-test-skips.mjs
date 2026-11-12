// T-73：把测试里「被 skip 的用例」从 CI 里那一行 `ℹ skipped N` 变成可读的汇总。
//
// 背景：后端 node --test（spec reporter）与 Playwright 的 skip 在 CI 只留一个计数，
// 看不到「跳了哪条、为什么跳、原因有没有归档」。本脚本静态扫描源码，产出：
//   - 一张 Markdown 表（层 / 文件:行 / 用例 / 类型 / 原因）；
//   - 按层、按类型的分组计数；
//   - 同一份 Markdown 追加写入 $GITHUB_STEP_SUMMARY（GitHub Actions 的 Job Summary）。
//
// 识别两类声明：
//   1) 声明式（static）：`{ skip: true }` / `{ skip: "..." }`，原因取其上方 6 行内
//      最近的一条实质注释文本（本仓库即每条用例上方的「T-23 验证位置」注释）。
//   2) 运行时（runtime）：`t.skip("...")` / `test.skip(...)` / `test.fixme(...)`，
//      原因优先取调用参数区最后一个字符串字面量（兼容 Playwright 的
//      `test.skip(condition, "reason")` 两参形式，首个参数常是条件串）。
//
// 纪律检查：声明式 skip 若上方 6 行内找不到任何注释文本，视为「未归档」——
// 打印醒目警告并把 process.exitCode = 1，让 CI 变红，逼迫补上原因/验证位置。
// 运行时 skip 自带内联原因，不参与该检查。
//
// 可选参数：--tap <path> 解析 TAP 的 `ok n - name # SKIP reason` 行，列出「本次
// 实际跳过」并与静态声明交叉核对两类差异。不提供该参数时完全不报错。
//
// 用法：
//   node scripts/summarize-test-skips.mjs
//   node scripts/summarize-test-skips.mjs --tap /tmp/server.tap
//   GITHUB_STEP_SUMMARY=/tmp/summary.md node scripts/summarize-test-skips.mjs
// Standalone: npm run summarize:skips

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SERVER_TESTS_DIR = path.join(ROOT, "server", "tests");
// Playwright 目录：e2e/ 与 tests/ 都探测，不存在的静默跳过，不报错。
const FRONTEND_DIRS = ["e2e", "tests"].map((d) => path.join(ROOT, d));
const FRONTEND_EXTS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs"]);
const LAYER_ORDER = { 后端: 0, 前端: 1 };

const rel = (abs) => path.relative(ROOT, abs).split(path.sep).join("/");
const cell = (s) =>
  String(s ?? "").replace(/\|/g, "\\|").replace(/\s*\n\s*/g, " ").trim();
const isCommentLine = (t) =>
  t.startsWith("//") || t.startsWith("/*") || t.startsWith("*");

// 逐字符收集一段文本里的所有字符串字面量（正确处理转义与三种引号）。
function stringsIn(text) {
  const out = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      let j = i + 1;
      let buf = "";
      while (j < text.length) {
        if (text[j] === "\\") {
          buf += text[j] + (text[j + 1] ?? "");
          j += 2;
          continue;
        }
        if (text[j] === quote) break;
        buf += text[j];
        j += 1;
      }
      out.push(buf);
      i = j + 1;
    } else {
      i += 1;
    }
  }
  return out;
}

// 从 `(` 之后开始扫描（可跨行），到匹配的右括号为止，收集实参区所有字符串。
function readCallArgs(lines, startLineIdx, openIdx) {
  const strings = [];
  let depth = 1;
  let r = startLineIdx;
  let i = openIdx + 1;
  while (r < lines.length && r < startLineIdx + 25) {
    const line = lines[r];
    while (i < line.length) {
      const ch = line[i];
      if (ch === '"' || ch === "'" || ch === "`") {
        const quote = ch;
        let j = i + 1;
        let buf = "";
        while (j < line.length) {
          if (line[j] === "\\") {
            buf += line[j] + (line[j + 1] ?? "");
            j += 2;
            continue;
          }
          if (line[j] === quote) break;
          buf += line[j];
          j += 1;
        }
        strings.push(buf);
        i = j + 1;
        continue;
      }
      if (ch === "(" || ch === "[" || ch === "{") depth += 1;
      else if (ch === ")" || ch === "]" || ch === "}") {
        depth -= 1;
        if (depth === 0) return strings;
      }
      i += 1;
    }
    r += 1;
    i = 0;
  }
  return strings;
}

// 从实参字符串里挑原因：优先最后一个「非纯数字、长度 >= 2」的字符串
// （Playwright 的 test.skip(condition, "reason") 里 reason 在最后，条件是 "1" 之类）。
function pickReason(strings) {
  const meaningful = strings.filter((s) => {
    const t = s.trim();
    return t.length >= 2 && !/^\d+$/.test(t);
  });
  return meaningful.length ? meaningful[meaningful.length - 1] : strings[0] || "";
}

// 取 [fromLine, toLine]（1-based，含端点）内的注释文本。
// 返回 has（是否存在任意注释行，含分隔线）与 texts（过滤掉分隔线后的实质文本）。
function collectComments(lines, fromLine, toLine) {
  const texts = [];
  let has = false;
  for (let ln = Math.max(1, fromLine); ln <= Math.min(lines.length, toLine); ln += 1) {
    const t = lines[ln - 1].trim();
    let body = null;
    if (t.startsWith("//")) {
      has = true;
      body = t.slice(2).trim();
    } else if (t.startsWith("/*") || t.startsWith("*")) {
      has = true;
      body = t.replace(/^\/\*+/, "").replace(/^\*+/, "").replace(/\*\/$/, "").trim();
    }
    // 纯分隔线（// ====、// ----、* 空行等）不算实质说明。
    if (body && !/^[=\-*/_\s#]+$/.test(body)) texts.push(body);
  }
  return { has, texts };
}

// 从 test( 起始行往后找第一个字符串字面量作为用例名（声明式 skip 会跨行）。
function extractTestName(lines, startIdx) {
  for (let j = startIdx; j < Math.min(startIdx + 12, lines.length); j += 1) {
    const line = lines[j];
    const t = line.trim();
    if (isCommentLine(t)) continue;
    const strings = stringsIn(line);
    if (strings.length) return strings[0];
    if (/=>|\bfunction\b|\basync\b/.test(line)) break;
  }
  return null;
}

// 识别所有 test( 调用起始行（test.before/after/describe 因 test 后是 '.' 不会命中）。
function findTestCalls(lines) {
  const calls = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (/(^|[^.\w])test\s*\(/.test(lines[i])) {
      const name = extractTestName(lines, i);
      calls.push({ line: i + 1, name: name || `（未命名 test @${i + 1}）` });
    }
  }
  return calls;
}

const allSkips = [];
const unarchived = [];

function scanFile(absFile, layer) {
  const lines = fs.readFileSync(absFile, "utf8").split(/\r?\n/);
  const calls = findTestCalls(lines);
  const relPath = rel(absFile);

  // skip 归属：最近的前一个 test( 起始行。
  const ownerName = (lineNo) => {
    let owner = null;
    for (const c of calls) {
      if (c.line <= lineNo) owner = c;
      else break;
    }
    return owner ? owner.name : "（未关联到 test）";
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const trimmed = line.trim();
    // 注释行里的「t.skip / { skip: 」只是说明文字，不能当声明（如文件头归档说明）。
    if (isCommentLine(trimmed)) continue;

    const lineNo = i + 1;
    const staticHit = /\{\s*skip\s*:\s*(?:true\b|["'`])/.test(line);
    const runtimeHit = line.match(/\b(\w+)\s*\.\s*(skip|fixme)\s*\(/);
    if (!staticHit && !runtimeHit) continue;

    const name = ownerName(lineNo);
    const loc = `${relPath}:${lineNo}`;

    if (staticHit) {
      const { has, texts } = collectComments(lines, lineNo - 6, lineNo);
      // 取最近一条实质注释，精准对应本用例上方的「T-23 验证位置」说明。
      const reason = texts.length ? texts[texts.length - 1] : "（上方无实质注释说明）";
      const entry = { layer, loc, name, type: "static", reason };
      allSkips.push(entry);
      if (!has) unarchived.push(entry);
    } else {
      const openIdx = runtimeHit.index + runtimeHit[0].length - 1;
      const strings = readCallArgs(lines, i, openIdx);
      let reason = pickReason(strings);
      if (!reason) {
        const { texts } = collectComments(lines, lineNo - 6, lineNo);
        reason = texts.length ? texts[texts.length - 1] : "（无内联原因）";
      }
      allSkips.push({ layer, loc, name, type: "runtime", reason });
    }
  }
}

function collectFrontendFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectFrontendFiles(full));
    else if (FRONTEND_EXTS.has(path.extname(entry.name))) out.push(full);
  }
  return out;
}

// 后端：server/tests/*.test.js（一层）。
if (fs.existsSync(SERVER_TESTS_DIR)) {
  for (const name of fs.readdirSync(SERVER_TESTS_DIR)) {
    if (!/\.test\.js$/.test(name)) continue;
    const abs = path.join(SERVER_TESTS_DIR, name);
    if (fs.statSync(abs).isFile()) scanFile(abs, "后端");
  }
}
// 前端：e2e/ 与 tests/ 存在才扫，不存在静默跳过（不报错、不打印）。
for (const dir of FRONTEND_DIRS) {
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) continue;
  for (const abs of collectFrontendFiles(dir)) scanFile(abs, "前端");
}

allSkips.sort(
  (a, b) =>
    (LAYER_ORDER[a.layer] - LAYER_ORDER[b.layer]) ||
    a.loc.localeCompare(b.loc, "zh")
);

// ---- 组装 Markdown 报告（stdout 与 Job Summary 用同一份）----
const out = [];
out.push("# Skip 用例汇总（T-73）");
out.push("");
out.push("> 扫描范围：后端 `server/tests/*.test.js` · 前端 Playwright（`e2e/` / `tests/`）");
out.push("");
out.push("| 层 | 文件:行 | 用例 | 类型 | 原因 |");
out.push("| --- | --- | --- | --- | --- |");
for (const s of allSkips) {
  out.push(`| ${s.layer} | \`${s.loc}\` | ${cell(s.name)} | ${s.type} | ${cell(s.reason)} |`);
}
out.push("");
out.push("## 分组统计");
const byLayer = {};
const byType = { static: 0, runtime: 0 };
for (const s of allSkips) {
  byLayer[s.layer] = (byLayer[s.layer] || 0) + 1;
  byType[s.type] += 1;
}
out.push(`- 合计：**${allSkips.length}** 条`);
out.push(
  `- 按层：${Object.entries(byLayer).map(([k, v]) => `${k} ${v}`).join(" · ") || "无"}`
);
out.push(`- 按类型：static ${byType.static} · runtime ${byType.runtime}`);

// ---- 可选：TAP 交叉核对 ----
function normName(s) {
  return String(s)
    .replace(/[「」【】（）()]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}
function namesMatch(a, b) {
  const na = normName(a);
  const nb = normName(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  const short = na.length <= nb.length ? na : nb;
  const long = na.length <= nb.length ? nb : na;
  return short.length >= 8 && long.includes(short);
}
function parseTapSkips(tapPath) {
  const text = fs.readFileSync(tapPath, "utf8");
  const result = [];
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*ok\s+\d+\s*-\s*(.*?)\s+#\s*SKIP\b\s*(.*)$/i);
    if (m) result.push({ name: m[1].trim(), reason: m[2].trim() });
  }
  return result;
}

let tapPath = null;
const tapIdx = process.argv.indexOf("--tap");
if (tapIdx !== -1) {
  const next = process.argv[tapIdx + 1];
  if (next && !next.startsWith("--")) tapPath = next;
  else process.stderr.write("ℹ --tap 未指定路径，跳过 TAP 交叉核对\n");
}

if (tapPath && fs.existsSync(tapPath)) {
  const tapSkips = parseTapSkips(tapPath);
  out.push("");
  out.push(`## 本次实际跳过（TAP：\`${tapPath}\`）—— 共 ${tapSkips.length} 条`);
  if (tapSkips.length === 0) out.push("- （无）");
  for (const t of tapSkips) {
    out.push(`- ${cell(t.name)}${t.reason ? ` — ${cell(t.reason)}` : ""}`);
  }
  out.push("");
  out.push("### 与静态声明交叉核对");
  const declaredButNotRun = [];
  const seen = new Set();
  for (const s of allSkips) {
    if (seen.has(s.name)) continue;
    seen.add(s.name);
    if (!tapSkips.some((t) => namesMatch(s.name, t.name))) declaredButNotRun.push(s);
  }
  const ranButNoDecl = tapSkips.filter(
    (t) => !allSkips.some((s) => namesMatch(t.name, s.name))
  );
  out.push(`- 静态声明但本次未触发（${declaredButNotRun.length}）：`);
  if (declaredButNotRun.length === 0) out.push("  - 无");
  for (const s of declaredButNotRun) out.push(`  - \`${s.loc}\` ${cell(s.name)}`);
  out.push(`- 运行时跳过但无静态声明（${ranButNoDecl.length}）：`);
  if (ranButNoDecl.length === 0) out.push("  - 无");
  for (const t of ranButNoDecl) out.push(`  - ${cell(t.name)}`);
} else if (tapPath) {
  process.stderr.write(`ℹ 未找到 TAP 文件 ${tapPath}，跳过交叉核对\n`);
}

// ---- 纪律检查：未归档的声明式 skip ----
if (unarchived.length > 0) {
  out.push("");
  out.push("## 未归档警告");
  out.push(
    `**以下 ${unarchived.length} 条声明式 skip 上方 6 行内无任何注释文本，判定为未归档（CI 失败）：**`
  );
  for (const s of unarchived) out.push(`- \`${s.loc}\` ${cell(s.name)}`);
  process.stderr.write(
    [
      "",
      "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!",
      `!! 未归档的静态声明式 skip（${unarchived.length} 条）：上方 6 行内无注释说明`,
      ...unarchived.map((s) => `!!   ${s.loc}  ${s.name}`),
      "!! 请在 skip 上方补充原因 / 验证位置注释后重试（T-73）。",
      "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!",
      "",
    ].join("\n")
  );
  process.exitCode = 1;
}

out.push("");
out.push(
  unarchived.length > 0
    ? "✗ 存在未归档 skip，CI 判定失败。"
    : "✓ skip 汇总完成：所有声明式 skip 均已归档。"
);

const report = out.join("\n");
console.log(report);

// ---- 写入 GitHub Actions Job Summary（本地无该变量时只打印，不建文件）----
const summaryPath = process.env.GITHUB_STEP_SUMMARY;
if (summaryPath) {
  try {
    fs.appendFileSync(summaryPath, `${report}\n`, "utf8");
    process.stderr.write(`ℹ 已追加 skip 汇总到 Job Summary：${summaryPath}\n`);
  } catch (err) {
    process.stderr.write(`⚠ 写入 GITHUB_STEP_SUMMARY 失败：${err.message}\n`);
  }
}
