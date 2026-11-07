import { renderHook } from "@testing-library/react";
import React from "react";
import { describe, expect, it } from "vitest";
import { UploadProvider } from "../context/UploadContext";
import { useEffectiveUploadConfig } from "./useEffectiveConfig";

const createWrapper =
  (props: { withCredentials?: boolean; authToken?: string }) =>
  ({ children }: { children: React.ReactNode }) => (
    <UploadProvider settingsSource="props" {...props}>
      {children}
    </UploadProvider>
  );

describe("useEffectiveUploadConfig 鉴权配置透传", () => {
  it("props 传入 withCredentials:true 时生效配置为 true（P0-2 回归）", () => {
    const { result } = renderHook(() => useEffectiveUploadConfig(), {
      wrapper: createWrapper({ withCredentials: true }),
    });

    expect(result.current.withCredentials).toBe(true);
  });

  it("未传 withCredentials 时默认 false（same-origin 语义）", () => {
    const { result } = renderHook(() => useEffectiveUploadConfig(), {
      wrapper: createWrapper({}),
    });

    expect(result.current.withCredentials).toBe(false);
  });

  it("authToken 等鉴权来源原样透传", () => {
    const { result } = renderHook(() => useEffectiveUploadConfig(), {
      wrapper: createWrapper({ authToken: "static-token" }),
    });

    expect(result.current.authToken).toBe("static-token");
  });
});
