/**
 * T-77：dev 入口「无重复 import」的静态判据。
 *
 * `src/main.tsx` 是 createRoot 挂载入口（已在覆盖率豁免白名单内），vitest
 * 不会加载它，因此用源码文本断言验证结构：把 dev 面板改回嵌套动态
 * `import("react-dom/client")` 会立刻转红。
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(resolve(process.cwd(), "src/main.tsx"), "utf8");

describe("T-77 dev 入口无重复 react-dom/client 动态 import", () => {
  it("只保留顶部一条静态 import，dev 面板复用同一个 createRoot", () => {
    expect(source).toContain('import { createRoot } from "react-dom/client"');
    expect(source).not.toMatch(/import\(\s*["']react-dom\/client["']\s*\)/);
    // 顶部挂载 + dev 面板挂载，且只有这两处调用 createRoot。
    expect(source.match(/createRoot\(/g)).toHaveLength(2);
    expect(source).toContain("createRoot(host).render(<Panel />)");
  });
});
