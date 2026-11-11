import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { UploadFile } from "../types/upload";

interface PostedMessage {
  type: string;
  fileId?: string;
  uploadConfig?: Record<string, unknown>;
  networkParams?: Record<string, unknown>;
}

class FakeUploadWorker {
  static instances: FakeUploadWorker[] = [];
  /** false 时挂起任务（不自动回 done），用于取消测试 */
  static autoRespond = true;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  posted: PostedMessage[] = [];
  terminated = false;

  constructor() {
    FakeUploadWorker.instances.push(this);
  }

  postMessage(message: PostedMessage) {
    this.posted.push(message);
    if (!FakeUploadWorker.autoRespond) {
      return;
    }
    // 立即以 done 收尾，让 runUploadTask 的 Promise 落地
    this.onmessage?.({
      data: { type: "done", skipped: false },
    } as MessageEvent);
  }

  terminate() {
    this.terminated = true;
  }
}

vi.mock("../worker/uploadWorker.ts?worker", () => ({
  default: FakeUploadWorker,
}));

// VU-25：mock 路径随源码同步改为 `?worker`（库构建时的 `&inline` 由 config 插件重写，
// 不影响测试）。测试 runner 使用 pool:"forks"（见 vite.config.ts），每个测试文件在独立
// 进程内运行、模块缓存不跨文件共享；本文件先 vi.resetModules() 重置本进程模块注册表，
// 再经下方 vi.mock("../worker/uploadWorker.ts?worker") 注入 FakeUploadWorker，
// 确保 bridge 拿到的永远是 mock 而非真实 Worker 实现。旧注释提及的「--no-isolate 共享
// 缓存」已不再适用（VU-60 校正：forks 进程天然隔离）。
vi.resetModules();
const { createUploadWorkerPool } = await import("./uploadWorkerBridge");

// T3.2：runUploadTask / cancelUploadTask / dispose 不再是模块级单例导出，
// 而是每个实例持有独立池。这里每个用例创建独立池，避免 worker 互相干扰。
let pool: ReturnType<typeof createUploadWorkerPool>;

const apiConfig = {
  baseURL: "",
  uploadApi: "/api/file/upload",
  checkApi: "/api/file/instant",
  mergeApi: "/api/file/merge",
};

const createFile = (): UploadFile =>
  ({
    id: "file-1",
    fileName: "demo.bin",
    fileSize: 1024,
    hash: "a".repeat(32),
    chunkSize: 1024 * 1024,
  }) as unknown as UploadFile;

const baseOptions = () => ({
  file: createFile(),
  fileRef: new File([new Uint8Array(8)], "demo.bin"),
  networkParams: {
    chunkConcurrency: 2,
    maxRetries: 3,
  },
});

describe("runUploadTask uploadConfig 贯通（T2.1 mergeApi）", () => {
  beforeEach(() => {
    // 创建独立 worker 池，保证每个测试从干净状态开始
    pool = createUploadWorkerPool();
    FakeUploadWorker.instances = [];
  });

  it("mergeApi 随 uploadConfig 下发到 Worker", async () => {
    await pool.runUploadTask({
      ...baseOptions(),
      uploadConfig: {
        baseURL: "https://upload.example.com",
        uploadApi: "/api/file/upload",
        checkApi: "/api/file/instant",
        mergeApi: "/api/file/merge",
      },
    });

    expect(FakeUploadWorker.instances).toHaveLength(1);
    const posted = FakeUploadWorker.instances[0]!.posted[0]!;
    expect(posted.type).toBe("upload");
    expect(posted.uploadConfig).toMatchObject({
      baseURL: "https://upload.example.com",
      uploadApi: "/api/file/upload",
      checkApi: "/api/file/instant",
      mergeApi: "/api/file/merge",
    });
  });

  it("自定义 mergeApi 原样透传（消费方可改合并路径）", async () => {
    await pool.runUploadTask({
      ...baseOptions(),
      uploadConfig: {
        baseURL: "https://upload.example.com/",
        uploadApi: "/api/file/upload",
        checkApi: "/api/file/instant",
        mergeApi: "/custom/merge-endpoint",
      },
    });

    const posted = FakeUploadWorker.instances[0]!.posted[0]!;
    expect(posted.uploadConfig?.mergeApi).toBe("/custom/merge-endpoint");
  });

  it("T-18：消息只带 Worker 实际消费的网络参数（上游混入死字段也进不来）", async () => {
    // 模拟 JS 消费方或旧调用点仍带着 networkType / fileConcurrency / chunkSize。
    const dirty = {
      ...baseOptions().networkParams,
      networkType: "wifi",
      fileConcurrency: 9,
      chunkSize: 777,
    } as unknown as Parameters<typeof pool.runUploadTask>[0]["networkParams"];

    await pool.runUploadTask({
      ...baseOptions(),
      networkParams: dirty,
      uploadConfig: apiConfig,
    });

    const posted = FakeUploadWorker.instances[0]!.posted[0]!;
    expect(posted.networkParams).toMatchObject({
      chunkConcurrency: 2,
      maxRetries: 3,
    });
    for (const dead of ["networkType", "fileConcurrency", "chunkSize"]) {
      expect(posted.networkParams).not.toHaveProperty(dead);
    }
  });

  it("T-58：消息只带白名单内的 uploadConfig 字段（JS 消费方混入未知字段也进不来）", async () => {
    // 模拟 JS 库消费方直接调 runUploadTask，在 uploadConfig 上挂了敏感/冗余字段。
    const dirty = {
      ...apiConfig,
      statusApi: "/api/file/status",
      authHeaders: { Authorization: "Bearer leaked" },
      rogueField: "should-not-leak",
      internalToken: "secret-should-not-leak",
    } as unknown as Parameters<typeof pool.runUploadTask>[0]["uploadConfig"];

    await pool.runUploadTask({
      ...baseOptions(),
      uploadConfig: dirty,
    });

    const posted = FakeUploadWorker.instances[0]!.posted[0]!;
    // 白名单字段原样存在（含 statusApi / authHeaders，二者此前是 UploadWorkerRequest
    // 漂移掉、Worker 真实消费却类型不可见的关键字段）。
    expect(posted.uploadConfig).toMatchObject({
      baseURL: "",
      uploadApi: "/api/file/upload",
      checkApi: "/api/file/instant",
      mergeApi: "/api/file/merge",
      statusApi: "/api/file/status",
      authHeaders: { Authorization: "Bearer leaked" },
    });
    // 未知字段不得进入 Worker 消息体。
    for (const dead of ["rogueField", "internalToken"]) {
      expect(posted.uploadConfig).not.toHaveProperty(dead);
    }
  });

  it("完成后的 Worker 被回收进空闲池（不泄漏）", async () => {
    await pool.runUploadTask({
      ...baseOptions(),
      uploadConfig: apiConfig,
    });

    await pool.runUploadTask({
      ...baseOptions(),
      uploadConfig: apiConfig,
    });

    // 第二个任务复用空闲 Worker，不新建实例
    expect(FakeUploadWorker.instances).toHaveLength(1);
    pool.dispose();
    expect(FakeUploadWorker.instances[0]!.terminated).toBe(true);
  });
});

describe("cancelUploadTask（T2.3 Worker CANCEL 协议）", () => {
  beforeEach(() => {
    pool = createUploadWorkerPool();
    FakeUploadWorker.instances = [];
    FakeUploadWorker.autoRespond = true;
  });

  afterEach(() => {
    FakeUploadWorker.autoRespond = true;
  });

  it("取消时向对应 Worker 发送 CANCEL，收到 cancelled 后任务以 cancelled 收场", async () => {
    FakeUploadWorker.autoRespond = false; // 挂起任务

    const taskPromise = pool.runUploadTask({
      ...baseOptions(),
      uploadConfig: apiConfig,
    });

    const worker = FakeUploadWorker.instances[0]!;
    expect(worker).toBeTruthy();

    pool.cancelUploadTask("file-1");

    // Worker 收到 CANCEL 指令
    const cancelMessage = worker.posted.find((m) => m.type === "cancel");
    expect(cancelMessage).toBeTruthy();

    // Worker 回应 cancelled（真实 Worker 中断在途请求后的确认）
    worker.onmessage?.({
      data: { type: "cancelled", fileId: "file-1" },
    } as MessageEvent);

    const result = await taskPromise;
    expect(result.cancelled).toBe(true);
    expect(result.success).toBe(false);
  });

  it("Worker 无 cancelled 响应时 800ms 后 terminate 兜底", async () => {
    vi.useFakeTimers();
    try {
      FakeUploadWorker.autoRespond = false;

      const taskPromise = pool.runUploadTask({
        ...baseOptions(),
        uploadConfig: apiConfig,
      });

      const worker = FakeUploadWorker.instances[0]!;
      pool.cancelUploadTask("file-1");
      expect(worker.terminated).toBe(false);

      await vi.advanceTimersByTimeAsync(799);
      expect(worker.terminated).toBe(false);

      await vi.advanceTimersByTimeAsync(2);
      expect(worker.terminated).toBe(true);

      // 兜底 terminate 不会让任务 Promise 泄漏：手动触发 error 收尾
      worker.onerror?.({
        message: "terminated by cancel fallback",
      } as unknown as Event);
      const result = await taskPromise;
      expect(result.success).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("对不在执行中的 fileId 调用 cancelUploadTask 是显式 no-op（返回 undefined，不改变任何任务状态）", () => {
    // 任务未启动：taskWorkerMap 无该 fileId，cancel 应直接返回 undefined，
    // 且不向任何 worker 投递 cancel 消息（无副作用）。
    const result = pool.cancelUploadTask("not-running");
    expect(result).toBeUndefined();
  });
});

describe("runUploadTask 消息回调路径（T2.8 补齐）", () => {
  beforeEach(() => {
    pool = createUploadWorkerPool();
    FakeUploadWorker.instances = [];
    FakeUploadWorker.autoRespond = true;
  });

  const runWithResponses = async (
    responses: Array<Record<string, unknown>>,
    hooks: Partial<
      Pick<
        Parameters<typeof pool.runUploadTask>[0],
        "onProgress" | "onRetry" | "onDebug"
      >
    > = {},
  ) => {
    // 拦截 postMessage：不自动回 done，按脚本投递响应序列
    const originalPost = FakeUploadWorker.prototype.postMessage;
    FakeUploadWorker.prototype.postMessage = function patched(
      message: PostedMessage,
    ) {
      this.posted.push(message);
      for (const next of responses.splice(0)) {
        this.onmessage?.({ data: next } as MessageEvent);
      }
    };
    try {
      return await pool.runUploadTask({
        ...baseOptions(),
        uploadConfig: apiConfig,
        ...hooks,
      });
    } finally {
      FakeUploadWorker.prototype.postMessage = originalPost;
    }
  };

  it("progress / retry / debug 消息转发到对应回调（T3.4 进度升级为字节级详情）", async () => {
    const onProgress = vi.fn();
    const onRetry = vi.fn();
    const onDebug = vi.fn();

    const progressDetail = {
      progress: 42,
      uploadedBytes: 43008,
      totalBytes: 1048576,
      speed: 1024,
      eta: 980,
    };

    const result = await runWithResponses(
      [
        { type: "progress", ...progressDetail, chunkIndex: 3 },
        { type: "retry", message: "network blip" },
        { type: "debug", message: "chunk md5 done", data: { count: 4 } },
        { type: "done", skipped: false },
      ],
      { onProgress, onRetry, onDebug },
    );

    expect(result.success).toBe(true);
    expect(onProgress).toHaveBeenCalledTimes(1);
    // 桥接层应原样透传字节级详情（不含 chunkIndex 等桥接无关字段）
    expect(onProgress).toHaveBeenCalledWith(progressDetail);
    expect(onRetry).toHaveBeenCalledWith("network blip");
    expect(onDebug).toHaveBeenCalledWith("chunk md5 done", { count: 4 });
  });

  it("error 消息以 errorMessage 收场", async () => {
    const result = await runWithResponses([
      { type: "error", message: "chunk 3 upload failed", failedChunks: [3] },
    ]);

    expect(result.success).toBe(false);
    expect(result.cancelled).toBeFalsy();
    expect(result.errorMessage).toBe("chunk 3 upload failed");
  });

  it("worker onerror 以错误原因收场且不回收 worker", async () => {
    FakeUploadWorker.autoRespond = false;
    const taskPromise = pool.runUploadTask({
      ...baseOptions(),
      uploadConfig: apiConfig,
    });

    const worker = FakeUploadWorker.instances[0]!;
    worker.onerror?.({ message: "worker crashed" } as unknown as Event);

    const result = await taskPromise;
    expect(result.success).toBe(false);
    expect(result.errorMessage).toBe("worker crashed");
    expect(worker.terminated).toBe(true);
  });

  it("signal 已 aborted 时不创建 worker，直接 cancelled", async () => {
    const controller = new AbortController();
    controller.abort();

    const result = await pool.runUploadTask({
      ...baseOptions(),
      uploadConfig: apiConfig,
      signal: controller.signal,
    });

    expect(result.cancelled).toBe(true);
    expect(FakeUploadWorker.instances).toHaveLength(0);
  });

  it("上传中外部 signal abort：任务 cancelled 且 worker 被销毁", async () => {
    FakeUploadWorker.autoRespond = false;
    const controller = new AbortController();
    const taskPromise = pool.runUploadTask({
      ...baseOptions(),
      uploadConfig: apiConfig,
      signal: controller.signal,
    });

    const worker = FakeUploadWorker.instances[0]!;
    controller.abort();

    const result = await taskPromise;
    expect(result.cancelled).toBe(true);
    expect(worker.terminated).toBe(true);
  });
});

describe("pauseUploadTask（D-05 方案 A：中断在途 + 回 paused）", () => {
  beforeEach(() => {
    pool = createUploadWorkerPool();
    FakeUploadWorker.instances = [];
    FakeUploadWorker.autoRespond = true;
  });

  afterEach(() => {
    FakeUploadWorker.autoRespond = true;
  });

  it("pauseUploadTask 向运行中的 Worker 发送 pause 指令（T3.3 分片边界暂停）", async () => {
    FakeUploadWorker.autoRespond = false; // 挂起任务，保持 Worker 存活
    const taskPromise = pool.runUploadTask({
      ...baseOptions(),
      uploadConfig: apiConfig,
    });

    const worker = FakeUploadWorker.instances[0]!;
    expect(worker).toBeTruthy();

    pool.pauseUploadTask("file-1");
    const pauseMessage = worker.posted.find((m) => m.type === "pause");
    expect(pauseMessage).toBeTruthy();
    expect(pauseMessage?.fileId).toBe("file-1");

    // Worker 回 paused：桥接层以 paused 收尾，并把 Worker 销毁（不回空闲池）
    worker.onmessage?.({
      data: {
        type: "paused",
        fileId: "file-1",
        uploadedChunks: 2,
        totalChunks: 5,
      },
    } as MessageEvent);

    const result = await taskPromise;
    expect(result.paused).toBe(true);
    expect(result.pausedChunks).toBe(2);
    expect(result.totalChunks).toBe(5);
    // 暂停态不回空闲池：该 Worker 被 terminate，避免挂起闭包泄漏
    expect(worker.terminated).toBe(true);
  });

  it("pauseUploadTask 对不存在/已释放的任务调用是显式 no-op（返回 undefined）", () => {
    // 任务未运行或已 paused 收尾（fileId 从 taskWorkerMap 移除）：直接返回 undefined。
    const result = pool.pauseUploadTask("ghost-file");
    expect(result).toBeUndefined();
  });

});

describe("P1-8 任务静默看门狗（worker 挂起不再永久停在 UPLOADING）", () => {
  beforeEach(() => {
    pool = createUploadWorkerPool();
    FakeUploadWorker.instances = [];
    FakeUploadWorker.autoRespond = false;
    vi.useFakeTimers();
  });

  afterEach(() => {
    FakeUploadWorker.autoRespond = true;
    vi.useRealTimers();
  });

  it("长时间无任何消息 → 以错误结束、销毁 Worker 且不回池", async () => {
    const taskPromise = pool.runUploadTask({
      ...baseOptions(),
      uploadConfig: apiConfig,
      idleTimeoutMs: 1000,
    });

    await vi.advanceTimersByTimeAsync(1000);
    const result = await taskPromise;

    expect(result.success).toBe(false);
    expect(result.errorMessage).toContain("无响应");
    const worker = FakeUploadWorker.instances[0]!;
    expect(worker.terminated).toBe(true);
    // 失联 Worker 不可复用（D-05 后 resumeUploadTask 已删除，续传统一主线程重跑）
  });

  it("持续有进度消息时不被误杀", async () => {
    let settled = false;
    const taskPromise = pool.runUploadTask({
      ...baseOptions(),
      uploadConfig: apiConfig,
      idleTimeoutMs: 1000,
    });
    taskPromise.then(() => {
      settled = true;
    });

    const worker = FakeUploadWorker.instances[0]!;
    // 每 800ms 一条进度，累计 2400ms 仍存活（按静默时长判定，不按总时长）
    for (let i = 0; i < 3; i += 1) {
      await vi.advanceTimersByTimeAsync(800);
      worker.onmessage?.({
        data: {
          type: "progress",
          progress: (i + 1) * 10,
          uploadedBytes: (i + 1) * 10,
          totalBytes: 100,
        },
      } as MessageEvent);
    }
    await Promise.resolve();
    expect(settled).toBe(false);

    worker.onmessage?.({
      data: { type: "done", skipped: false },
    } as MessageEvent);
    const result = await taskPromise;
    expect(result.success).toBe(true);
  });
});
