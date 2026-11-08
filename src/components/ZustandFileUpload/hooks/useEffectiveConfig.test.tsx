import { render, renderHook } from "@testing-library/react";
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

  it("VU-45：宿主重渲染且数组内容不变时，配置对象引用保持不变", () => {
    const seen: ReturnType<typeof useEffectiveUploadConfig>[] = [];
    const Probe = () => {
      seen.push(useEffectiveUploadConfig());
      return null;
    };
    const Host = ({ tick, allowed }: { tick: number; allowed: string[] }) => (
      <UploadProvider settingsSource="props" allowedFileTypes={allowed}>
        <Probe />
        <span>{tick}</span>
      </UploadProvider>
    );

    const { rerender } = render(
      <Host tick={0} allowed={[".png", "image/jpeg"]} />
    );
    const first = seen.at(-1)!;

    // 模拟 App 因 notify 等无关状态重渲染，且传入内容相同的新数组
    rerender(<Host tick={1} allowed={[".png", "image/jpeg"]} />);
    const second = seen.at(-1)!;
    expect(second).toBe(first);
    expect(second.allowedFileTypes).toEqual([".png", "image/jpeg"]);

    // 内容确实变化时必须更新，不能被签名缓存吞掉
    rerender(<Host tick={2} allowed={[".pdf"]} />);
    expect(seen.at(-1)).not.toBe(first);
    expect(seen.at(-1)!.allowedFileTypes).toEqual([".pdf"]);
  });
});
