import { describe, it, expect } from "vitest";

/**
 * 注意：本环境下 vitest 会把源码模块里的 `import.meta.env` 静态内联为一个固定对象
 * （`{ BASE_URL, DEV, MODE, PROD, SSR }`），`vi.stubEnv` 与 `process.env` 的
 * `VITE_` 前缀变量均不会注入到源码模块的 `import.meta.env`。因此 `API_BASE_URL`
 * 在本测试环境中恒为 ""（相对路径/回退分支）。
 *
 * 受此限制，无法在本环境通过改变 env 来覆盖「带 base」的分支。以下测试覆盖可确定
 * 的行为：
 *   1. API_PATHS 常量结构；
 *   2. `buildApiUrl` 的拼接契约：`buildApiUrl(p) === API_BASE_URL + p`；
 *   3. 无 base（env 回退）场景下 buildApiUrl 直接返回 path（相对路径拼接正确）。
 * 若未来 vitest 放开 import.meta.env 注入，可补充「带 base 且 trim 尾部斜杠」用例。
 */

describe("API_PATHS 常量结构", () => {
  it("暴露完整的文件上传端点集合", async () => {
    const { API_PATHS } = await import("./api");
    expect(API_PATHS).toEqual({
      file: {
        instant: "/api/file/instant",
        status: "/api/file/status",
        upload: "/api/file/upload",
        merge: "/api/file/merge",
      },
    });
  });

  it("四个端点均以 /api/file/ 为前缀且互不相同", async () => {
    const { API_PATHS } = await import("./api");
    const paths = Object.values(API_PATHS.file);
    expect(paths.every((p) => p.startsWith("/api/file/"))).toBe(true);
    expect(new Set(paths).size).toBe(paths.length);
  });
});

describe("API_BASE_URL 派生", () => {
  it("本测试环境下回落为相对路径（空字符串），且为 string 类型", async () => {
    const { API_BASE_URL } = await import("./api");
    expect(typeof API_BASE_URL).toBe("string");
    expect(API_BASE_URL).toBe("");
  });
});

describe("buildApiUrl 拼接契约", () => {
  it("对任意 path 满足 buildApiUrl(p) === API_BASE_URL + p（拼接逻辑）", async () => {
    const { API_BASE_URL, buildApiUrl } = await import("./api");
    const p = "/api/file/upload";
    expect(buildApiUrl(p)).toBe(API_BASE_URL + p);
  });

  it("无 base 时直接返回 path（相对路径拼接正确，无多余斜杠）", async () => {
    const { buildApiUrl } = await import("./api");
    expect(buildApiUrl("/api/file/upload")).toBe("/api/file/upload");
    expect(buildApiUrl("/api/file/instant")).toBe("/api/file/instant");
  });

  it("buildApiUrl 对 API_PATHS 各端点均正确拼接", async () => {
    const { API_PATHS, buildApiUrl } = await import("./api");
    for (const path of Object.values(API_PATHS.file)) {
      expect(buildApiUrl(path)).toBe(path);
    }
  });

  it("path 以非斜杠开头时仍按原样拼接（不擅自插入分隔符）", async () => {
    const { API_BASE_URL, buildApiUrl } = await import("./api");
    expect(buildApiUrl("api/file/status")).toBe(API_BASE_URL + "api/file/status");
  });
});
