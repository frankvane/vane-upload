import { UploadFile, type UploadHashMode, type UploadProgressDetail } from "../types/upload";
import {
  UploadWorkerRequest,
  UploadWorkerResponse,
} from "../types/workerProtocol";
// 内联 worker（见 useFileProcessor 注释）：避免发布后被消费方当作外部资产 404。
import UploadWorker from "../worker/uploadWorker.ts?worker&inline";
import { buildChunkKey } from "../../../shared/chunkKey";

interface UploadWorkerNetworkParams {
  networkType: string;
  fileConcurrency: number;
  chunkConcurrency: number;
  chunkSize: number;
  maxRetries: number;
}

interface UploadWorkerApiConfig {
  baseURL: string;
  uploadApi: string;
  checkApi: string;
  mergeApi: string;
  authHeaders?: Record<string, string>;
  withCredentials?: boolean;
  /** 调试日志开关（默认 false，关闭时 Worker 内不产生日志） */
  debug?: boolean;
  /** 文件哈希模式（T3.1）：sample 时服务端合并跳过全量 md5 强校验 */
  hashMode?: UploadHashMode;
}

interface RunUploadTaskOptions {
  file: UploadFile;
  /** 主线程文件引用（T3.1 流式分片）：File 结构化克隆进 Worker，按需 slice 读取 */
  fileRef: File;
  networkParams: UploadWorkerNetworkParams;
  uploadConfig: UploadWorkerApiConfig;
  signal?: AbortSignal;
  /** T3.4：进度载荷升级为字节级详情（progress/speed/eta） */
  onProgress?: (detail: UploadProgressDetail) => void;
  onRetry?: (message: string) => void;
  onDebug?: (message: string, data?: Record<string, unknown>) => void;
  /**
   * P1-8：任务静默超时（毫秒）。worker 在该时长内没有任何消息即判定失联并中止，
   * 默认 120s；传 0 关闭看门狗（仅建议测试使用）。
   */
  idleTimeoutMs?: number;
}

interface UploadTaskResult {
  success: boolean;
  skipped: boolean;
  cancelled?: boolean;
  /** T3.3：任务被暂停（分片边界挂起），等待 resume */
  paused?: boolean;
  /** T3.3：暂停时已上传分片数（用于 pausedChunks 记录） */
  pausedChunks?: number;
  /** T3.3：总分片数 */
  totalChunks?: number;
  errorMessage?: string;
}

export interface UploadWorkerPool {
  runUploadTask: (options: RunUploadTaskOptions) => Promise<UploadTaskResult>;
  cancelUploadTask: (fileId: string) => void;
  /** T3.3：向处理该文件的 Worker 发送暂停指令（分片边界安全暂停） */
  pauseUploadTask: (fileId: string) => void;
  /**
   * T3.3：向处理该文件的 Worker 发送继续指令。
   * @returns 是否存在存活的 Worker 任务；false 表示任务已结束/释放，需主线程重新发起上传
   */
  resumeUploadTask: (fileId: string) => boolean;
  /** 释放本实例持有的全部 worker（组件卸载时调用） */
  dispose: () => void;
}

const createUploadWorker = () => new UploadWorker();

// CANCEL 兜底时长：worker 无 cancelled 响应即强制终止
const CANCEL_FALLBACK_MS = 800;

// P1-8：任务级「静默」看门狗。worker 内部只有单次 fetch 的 30s 请求超时，
// 覆盖不到 MD5 串行预计算阶段，也覆盖不到线程挂起 / 被浏览器冻结的场景；
// 一旦失去响应，runUploadTask 的 Promise 永不 settle，文件会永久停在 UPLOADING。
// 这里按「静默时长」而非「总时长」判定：只要还在推进进度就不会被误杀，大文件安全。
const TASK_IDLE_TIMEOUT_MS = 120_000;

/**
 * 创建每实例上传 Worker 池（T3.2 单例治理）。
 *
 * 原实现为模块级单例池：所有 <FileUpload> 实例共享同一批 worker，卸载即
 * 全部 terminate，多实例互相干扰。现改为工厂，每个实例持有独立池，卸载时
 * 仅 dispose 自身持有的 worker（引用计数语义：池随实例生命周期）。
 */
export const createUploadWorkerPool = (): UploadWorkerPool => {
  const workerPool = new Set<Worker>();
  const idleWorkers: Worker[] = [];
  /** fileId → 正在处理该文件的 Worker，供 cancelUploadTask 精确取消（P1-8） */
  const taskWorkerMap = new Map<string, Worker>();

  const acquireUploadWorker = (): Worker => {
    const existingWorker = idleWorkers.pop();
    if (existingWorker) {
      return existingWorker;
    }

    const worker = createUploadWorker();
    workerPool.add(worker);
    return worker;
  };

  const releaseUploadWorker = (worker: Worker) => {
    if (!workerPool.has(worker)) {
      return;
    }

    if (!idleWorkers.includes(worker)) {
      idleWorkers.push(worker);
    }
  };

  const disposeUploadWorker = (worker: Worker) => {
    if (!workerPool.has(worker)) {
      return;
    }

    workerPool.delete(worker);
    const idleIndex = idleWorkers.indexOf(worker);
    if (idleIndex >= 0) {
      idleWorkers.splice(idleIndex, 1);
    }
    worker.terminate();
  };

  const cancelUploadTask = (fileId: string): void => {
    const worker = taskWorkerMap.get(fileId);
    if (!worker) {
      return;
    }

    worker.postMessage({ type: "cancel", fileId });

    setTimeout(() => {
      // cancelled 响应到达后 finish/cleanup 会将 fileId 从 map 移除；
      // 仍残留说明 worker 无响应，强制终止兜底
      if (taskWorkerMap.get(fileId) === worker) {
        taskWorkerMap.delete(fileId);
        disposeUploadWorker(worker);
      }
    }, CANCEL_FALLBACK_MS);
  };

  const pauseUploadTask = (fileId: string): void => {
    const worker = taskWorkerMap.get(fileId);
    if (!worker) {
      return;
    }
    worker.postMessage({ type: "pause", fileId });
  };

  const resumeUploadTask = (fileId: string): boolean => {
    const worker = taskWorkerMap.get(fileId);
    if (!worker) {
      // 任务已结束或 Worker 已释放（如刷新/卸载）：主线程应重新发起上传续传
      return false;
    }
    worker.postMessage({ type: "resume", fileId });
    return true;
  };

  const runUploadTask = (
    options: RunUploadTaskOptions
  ): Promise<UploadTaskResult> => {
    if (options.signal?.aborted) {
      return Promise.resolve({
        success: false,
        skipped: false,
        cancelled: true,
        errorMessage: "上传已取消",
      });
    }

    const worker = acquireUploadWorker();

    return new Promise<UploadTaskResult>((resolve) => {
      let settled = false;
      let shouldRecycleWorker = true;

      // P1-8 看门狗：worker 长时间无任何消息 → 判定失联，终止并让上层可重试续传
      const idleTimeoutMs = options.idleTimeoutMs ?? TASK_IDLE_TIMEOUT_MS;
      let idleTimer: ReturnType<typeof setTimeout> | null = null;

      const clearIdleTimer = () => {
        if (idleTimer !== null) {
          clearTimeout(idleTimer);
          idleTimer = null;
        }
      };

      const bumpIdleTimer = () => {
        clearIdleTimer();
        // settled / 暂停 / 取消后不再重启；0 表示显式关闭
        if (settled || idleTimeoutMs <= 0 || options.signal?.aborted) {
          return;
        }
        idleTimer = setTimeout(() => {
          idleTimer = null;
          if (settled) {
            return;
          }
          // 失联 worker 内部状态不可信，不回空闲池，直接销毁
          shouldRecycleWorker = false;
          finish({
            success: false,
            skipped: false,
            errorMessage: `上传任务 ${Math.round(
              idleTimeoutMs / 1000
            )}s 无响应，已中止（可重试续传）`,
          });
        }, idleTimeoutMs);
      };

      const finish = (result: UploadTaskResult) => {
        if (settled) {
          return;
        }
        settled = true;
        taskWorkerMap.delete(options.file.id);
        cleanup();
        resolve(result);
      };

      const handleAbort = () => {
        shouldRecycleWorker = false;
        taskWorkerMap.delete(options.file.id);

        if (settled) {
          // 任务已结束又收到取消（竞态）：仍需处置 worker 与监听，避免泄漏
          if (options.signal) {
            options.signal.removeEventListener("abort", handleAbort);
          }
          worker.onmessage = null;
          worker.onerror = null;
          disposeUploadWorker(worker);
          return;
        }

        finish({
          success: false,
          skipped: false,
          cancelled: true,
          errorMessage: "上传已取消",
        });
      };

      const cleanup = () => {
        clearIdleTimer();
        if (options.signal) {
          options.signal.removeEventListener("abort", handleAbort);
        }
        worker.onmessage = null;
        worker.onerror = null;

        if (shouldRecycleWorker) {
          releaseUploadWorker(worker);
          return;
        }

        disposeUploadWorker(worker);
      };

      if (options.signal) {
        options.signal.addEventListener("abort", handleAbort, { once: true });
      }

      worker.onerror = (event) => {
        shouldRecycleWorker = false;
        const reason = event.message || "Upload worker failed";
        finish({ success: false, skipped: false, errorMessage: reason });
      };

      worker.onmessage = (event: MessageEvent<UploadWorkerResponse>) => {
        const payload = event.data;

        // 任意消息都说明 worker 存活，重置静默看门狗
        bumpIdleTimer();

        if (payload.type === "debug") {
          options.onDebug?.(payload.message, payload.data);
          return;
        }

        if (payload.type === "progress") {
          // T3.4：进度载荷升级为字节级详情（progress/speed/eta）
          options.onProgress?.({
            progress: payload.progress,
            uploadedBytes: payload.uploadedBytes,
            totalBytes: payload.totalBytes,
            speed: payload.speed,
            eta: payload.eta,
          });
          return;
        }

        if (payload.type === "retry") {
          options.onRetry?.(payload.message ?? "retry");
          return;
        }

        if (payload.type === "done") {
          finish({
            success: true,
            skipped: Boolean(payload.skipped),
          });
          return;
        }

        if (payload.type === "error") {
          finish({
            success: false,
            skipped: false,
            errorMessage: payload.message ?? "Upload failed",
          });
          return;
        }

        if (payload.type === "paused") {
          // T3.3：Worker 已在分片边界挂起。本实例的 runUploadTask 收尾，并把该
          // Worker 直接销毁（不回空闲池）：当前暂停态下 Worker 内部仍挂起于
          // waitWhilePaused，回池会留下永不被唤醒的挂起闭包与残留 Map 条目；
          // 续传由主线程重新发起（服务端分片校验保证字节级续传），无需复用该 Worker。
          shouldRecycleWorker = false;
          finish({
            success: false,
            skipped: false,
            paused: true,
            pausedChunks: payload.uploadedChunks,
            totalChunks: payload.totalChunks,
          });
          return;
        }

        if (payload.type === "resumed") {
          // T3.3：Worker 已解除挂起并从断点续传，不在此结束任务
          return;
        }

        if (payload.type === "cancelled") {
          // Worker 确认已中断该文件的在途请求
          finish({
            success: false,
            skipped: false,
            cancelled: true,
            errorMessage: "上传已取消",
          });
        }
      };

      taskWorkerMap.set(options.file.id, worker);

      const message: UploadWorkerRequest = {
        type: "upload",
        fileInfo: {
          id: options.file.id,
          fileName: options.file.fileName,
          fileSize: options.file.fileSize,
          hash: options.file.hash,
          chunkSize: options.file.chunkSize,
          // 分片存储键：chunkSize 变化（网络自适应）后新旧分片互不污染（P1-6）
          chunkKey: buildChunkKey(
            options.file.hash,
            options.file.fileSize,
            options.file.chunkSize
          ),
        },
        fileRef: options.fileRef,
        networkParams: options.networkParams,
        uploadConfig: options.uploadConfig,
      };

      // 注意：File 通过结构化克隆传入 Worker（不转移），主线程注册表仍需持有该
      // 引用以支持刷新后的重选/重试；若用 transfer 列表转移，主线程引用会被置空。
      bumpIdleTimer();
      worker.postMessage(message);
    });
  };

  const dispose = () => {
    for (const worker of Array.from(workerPool)) {
      disposeUploadWorker(worker);
    }
    taskWorkerMap.clear();
  };

  return {
    runUploadTask,
    cancelUploadTask,
    pauseUploadTask,
    resumeUploadTask,
    dispose,
  };
};
