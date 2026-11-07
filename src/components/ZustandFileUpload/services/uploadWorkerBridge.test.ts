import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { UploadFile } from "../types/upload";

interface PostedMessage {
  type: string;
  fileId?: string;
  uploadConfig?: Record<string, unknown>;
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

vi.mock("../worker/uploadWorker.ts?worker&inline", () => ({
  default: FakeUploadWorker,
}));

// 全量套件使用 --no-isolate 共享模块缓存：若其他测试先加载过 bridge，真实的
// inline worker 模块会被缓存，本文件的 vi.mock 就无法生效。先清缓存再导入。
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
    networkType: "wifi",
    fileConcurrency: 2,
    chunkConcurrency: 2,
    chunkSize: 1024 * 1024,
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

  it("对不在执行中的 fileId 调用是安全的 no-op", () => {
    expect(() => pool.cancelUploadTask("not-running")).not.toThrow();
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

describe("pauseUploadTask / resumeUploadTask（T3.3）", () => {
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

  it("resumeUploadTask 对运行中的任务返回 true 并发送 resume（T3.3 解除挂起）", async () => {
    FakeUploadWorker.autoRespond = false;
    const taskPromise = pool.runUploadTask({
      ...baseOptions(),
      uploadConfig: apiConfig,
    });

    const worker = FakeUploadWorker.instances[0]!;

    const alive = pool.resumeUploadTask("file-1");
    expect(alive).toBe(true);
    const resumeMessage = worker.posted.find((m) => m.type === "resume");
    expect(resumeMessage).toBeTruthy();
    expect(resumeMessage?.fileId).toBe("file-1");

    // resume 不结束任务：用 done 收尾
    worker.onmessage?.({
      data: { type: "done", skipped: false },
    } as MessageEvent);
    const result = await taskPromise;
    expect(result.success).toBe(true);
  });

  it("resumeUploadTask 对不存在/已暂停释放的任务返回 false（触发主线程重跑）", () => {
    // 任务未启动或已 paused 收尾（fileId 从 taskWorkerMap 移除）→ 返回 false
    const alive = pool.resumeUploadTask("ghost-file");
    expect(alive).toBe(false);
  });

  it("pauseUploadTask 对不存在的任务调用安全 no-op", () => {
    expect(() => pool.pauseUploadTask("ghost-file")).not.toThrow();
  });

  it("paused 后再 resume 同一 fileId：因 Worker 已销毁，resumeUploadTask 返回 false", async () => {
    FakeUploadWorker.autoRespond = false;
    const taskPromise = pool.runUploadTask({
      ...baseOptions(),
      uploadConfig: apiConfig,
    });

    const worker = FakeUploadWorker.instances[0]!;
    pool.pauseUploadTask("file-1");
    worker.onmessage?.({
      data: {
        type: "paused",
        fileId: "file-1",
        uploadedChunks: 1,
        totalChunks: 3,
      },
    } as MessageEvent);
    await taskPromise;

    // Worker 已销毁且 fileId 已从 taskWorkerMap 移除
    expect(worker.terminated).toBe(true);
    expect(pool.resumeUploadTask("file-1")).toBe(false);
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
    // 失联 Worker 不可复用
    expect(pool.resumeUploadTask("file-1")).toBe(false);
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
