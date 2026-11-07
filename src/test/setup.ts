import "@testing-library/jest-dom/vitest";
import { afterEach, vi } from "vitest";
import { cleanup } from "@testing-library/react";
import "fake-indexeddb/auto";

afterEach(() => {
  cleanup();
});

if (!window.matchMedia) {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}

if (!window.ResizeObserver) {
  class ResizeObserver {
    observe() {
      // noop
    }
    unobserve() {
      // noop
    }
    disconnect() {
      // noop
    }
  }

  Object.defineProperty(window, "ResizeObserver", {
    writable: true,
    value: ResizeObserver,
  });
}

const originalGetComputedStyle = window.getComputedStyle.bind(window);
Object.defineProperty(window, "getComputedStyle", {
  writable: true,
  value: ((elt: Element) => originalGetComputedStyle(elt)) as typeof window.getComputedStyle,
});

// jsdom 的 Blob/File 未实现 arrayBuffer()（浏览器原生支持）。Worker 流式分片
// 依赖 File.slice(start,end).arrayBuffer()，故在此为测试环境补齐该能力，
// 使上传 Worker 的单测可在 jsdom 下真实跑完分片读取与 md5 计算。
if (typeof Blob !== "undefined" && typeof Blob.prototype.arrayBuffer !== "function") {
  Blob.prototype.arrayBuffer = function arrayBuffer(this: Blob): Promise<ArrayBuffer> {
    return new Promise<ArrayBuffer>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as ArrayBuffer);
      reader.onerror = () => reject(reader.error);
      reader.readAsArrayBuffer(this);
    });
  };
}

// jsdom 下 self === window，其 postMessage 要求 (message, targetOrigin) 两参数；
// 而 Worker 模块使用单参数语义（ctx.postMessage(message)）。Vite 的 `?worker&inline`
// 测试变换会把 Worker 消息经 window.postMessage 路由，触发 Worker 模块注册的
// message 监听，进而以单参数回传消息（如 sendProgressUpdate）→ jsdom 抛
// "postMessage requires 2 arguments" 未捕获异常。此处包裹为兼容单/双参数：
// 单参数（Worker 风格）在测试环境无真实 Worker，安全丢弃；双参数（跨 frame 通信）
// 保持 jsdom 原语义。（各 Worker 单测会自行覆盖 self.postMessage 收集消息，不受影响。）
if (typeof window !== "undefined" && typeof window.postMessage === "function") {
  const realPostMessage = window.postMessage.bind(window);
  (window as unknown as {
    postMessage: (message: unknown, targetOrigin?: unknown, transfer?: unknown) => void;
  }).postMessage = function postMessageSafe(
    message: unknown,
    targetOrigin?: unknown,
    transfer?: unknown
  ): void {
    // 双参数（含 targetOrigin）视为合法跨 frame 调用，保持原行为
    if (arguments.length >= 2 && targetOrigin !== undefined) {
      realPostMessage(message as never, targetOrigin as never, transfer as never);
      return;
    }
    // 单参数（Worker 风格）：测试环境无真实 Worker，安全丢弃，避免未捕获异常
  };
}

