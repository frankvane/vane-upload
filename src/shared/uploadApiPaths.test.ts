import { describe, expect, it } from "vitest";
import {
  DEFAULT_ABORT_API,
  DEFAULT_STATUS_API,
  resolveAbortApi,
  resolveStatusApi,
} from "./uploadApiPaths";

describe("resolveStatusApi（T-19）", () => {
  it("默认命名约定仍推导 /status", () => {
    expect(resolveStatusApi("/api/file/instant")).toBe("/api/file/status");
    expect(resolveStatusApi("/api/file/instant/")).toBe("/api/file/status");
  });

  it("自定义 checkApi 不符合命名约定时，未显式配置才回落内置路径", () => {
    expect(resolveStatusApi("/v2/quick-check")).toBe(DEFAULT_STATUS_API);
  });

  it("判据：自定义 checkApi 且不符合命名约定时，显式 statusApi 生效而非静默回落", () => {
    expect(resolveStatusApi("/v2/quick-check", "/v2/resume-state")).toBe(
      "/v2/resume-state"
    );
    // 即便默认命名约定能推导，显式值也必须优先
    expect(resolveStatusApi("/api/file/instant", "/custom/status")).toBe(
      "/custom/status"
    );
  });

  it("空串显式值按未配置处理，不会拼出空路径", () => {
    expect(resolveStatusApi("/v2/quick-check", "  ")).toBe(DEFAULT_STATUS_API);
  });
});

describe("resolveAbortApi（T-19）", () => {
  it("默认命名约定仍推导 /abort", () => {
    expect(resolveAbortApi("/api/file/upload")).toBe("/api/file/abort");
    expect(resolveAbortApi("/api/file/upload/")).toBe("/api/file/abort");
  });

  it("自定义 uploadApi 不符合命名约定时，未显式配置才回落内置路径", () => {
    expect(resolveAbortApi("/v2/send-chunk")).toBe(DEFAULT_ABORT_API);
  });

  it("显式 abortApi 优先于推导", () => {
    expect(resolveAbortApi("/v2/send-chunk", "/v2/discard")).toBe("/v2/discard");
    expect(resolveAbortApi("/api/file/upload", "/v2/discard")).toBe(
      "/v2/discard"
    );
  });
});
