import { UploadFile, type UploadHashMode, type UploadProgressDetail } from "../types/upload";
import {
  UploadWorkerRequest,
  UploadWorkerResponse,
} from "../types/workerProtocol";
// VU-25：demo/应用构建下产出独立 worker asset，不再把 ~900 行 worker 源码
// base64 内联进主 bundle（独立 chunk 可缓存、可并行加载）。
// 库构建由 vite.lib.config.ts 的插件把 `?worker` 重写为 `?worker&inline`，
// 保证发布产物自包含、消费方无需解析外部 worker 资产。
import UploadWorker from "../worker/uploadWorker.ts?worker";
import { buildChunkKey } from "../../../shared/chunkKey";
import { markPerf } from "../../../shared/perfTrace";
import { createProgressThrottle } from "./progressThrottle";

/**
 * T-18：只保留**上传 Worker 实际读取**的字段（uploadWorker.ts 的
 * `networkParams?.chunkConcurrency / maxRetries / timeout / retryInterval`）。
 * 此前还塞了 networkType / fileConcurrency / chunkSize，三者都只服务主线程
 * 的 UI 展示、批次并发与文件分片键计算，Worker 从不消费——每次任务都白克隆一遍。
 */
interface UploadWorkerNetworkParams {
  chunkConcurrency: number;
  maxRetries: number;
  timeout?: number;
  retryInterval?: number;
}

interface UploadWorkerApiConfig {
  baseURL: string;
  uploadApi: string;
  checkApi: string;
  mergeApi: string;
  /** T-19：显式指定续传状态接口；缺省时 Worker 自行按命名约定推导。 */
  statusApi?: string;
  authHeaders?: Record<string, string>;
  withCredentials?: boolean;
  /** 调试日志开关（默认 false，关闭时 Worker 内不产生日志） */
  debug?: boolean;
  /** 文件哈希模式（T3.1）：sample 时服务端合并跳过全量 md5 强校验 */
  hashMode?: UploadHashMode;
}

interface RunUploadTaskOptions {
  file: UploadFile;
  /**
   * 主线程文件引用（T3.1 流式分片）：File 结构化克隆进 Worker，按需 slice 读取。
   * 刷新后续传时为空，改由 chunkCache 提供分片字节。
   */
  fileRef?: File;
  /** 分片缓存（方案 A）：fileRef 缺失时 Worker 从 IndexedDB 读取尚未确认的分片 */
  chunkCache?: { instanceId: string };
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
  /** 分片缓存缺片：需用户重新选择文件（而非普通上传失败） */
  cacheMissing?: boolean;
  errorMessage?: string;
}

export interface UploadWorkerPool {
  runUploadTask: (options: RunUploadTaskOptions) => Promise<UploadTaskResult>;
  cancelUploadTask: (fileId: string) => void;
  /** 向处理该文件的 Worker 发送暂停指令（D-05 方案 A：中断在途并回 paused） */
  pauseUploadTask: (fileId: string) => void;
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
  /**
   * fileId → 该任务「强制结算」回调（F-01 修复）。
   * 取消时若 Worker 无法在兜底窗口内回应 cancelled（典型：Worker 正卡在长同步
   * 哈希/大文件合并等待里，postMessage 排在队尾），只 terminate 而不结算会让
   * runUploadTask 的 Promise 永不 resolve，文件永久停在「上传中」。
   */
  const taskSettleMap = new Map<string, () => void>();

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
    // 记录「本次取消所针对的那个任务」的结算回调身份。
    // 必须按身份比对而非按 fileId 判断：用户「取消 → 立刻继续」时，同一 fileId
    // 会很快挂上新任务，旧定时器若按 fileId 命中就会把新任务也判成取消。
    const scheduledSettle = taskSettleMap.get(fileId);

    if (!worker && !scheduledSettle) {
      return;
    }

    if (worker) {
      worker.postMessage({ type: "cancel", fileId });
    }

    setTimeout(() => {
      // 任务已结算，或已换成新任务（取消→继续）：本次兜底作废
      if (!scheduledSettle || taskSettleMap.get(fileId) !== scheduledSettle) {
        return;
      }

      // F-01 兜底：Worker 未在窗口内响应 cancel。此前只 terminate 不结算，
      // 导致 runUploadTask 的 Promise 永不 settle —— 行永久停在「上传中 100%」、
      // 速率冻结，既不能继续也无报错。这里同时「销毁 Worker + 强制结算」。
      taskWorkerMap.delete(fileId);
      if (worker) {
        disposeUploadWorker(worker);
      }
      scheduledSettle();
    }, CANCEL_FALLBACK_MS);
  };

  const pauseUploadTask = (fileId: string): void => {
    const worker = taskWorkerMap.get(fileId);
    if (!worker) {
      return;
    }
    worker.postMessage({ type: "pause", fileId });
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

      // VU-40：同一帧内的多条 progress 合并为最后一条，避免高频消息
      // 把 store 更新 / 宿主回调放大成每条一次。收尾时 flush 保证不丢 100%。
      const progressThrottle = createProgressThrottle<UploadProgressDetail>(
        (detail) => options.onProgress?.(detail)
      );

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
        progressThrottle.flush();
        taskWorkerMap.delete(options.file.id);
        taskSettleMap.delete(options.file.id);
        cleanup();
        resolve(result);
      };

      // F-01：把「强制结算」能力暴露给 cancelUploadTask。取消后 Worker 若卡在
      // 长同步任务里无法及时回应，兜底路径据此结算，保证上层状态机一定收尾。
      taskSettleMap.set(options.file.id, () => {
        shouldRecycleWorker = false;
        finish({
          success: false,
          skipped: false,
          cancelled: true,
          errorMessage: "上传已取消",
        });
      });

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
        progressThrottle.cancel();
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
          // VU-40：交给节流器合并，任务收尾时由 finish() 强制 flush。
          progressThrottle.push({
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
          // VU-07 双保险：若主线程已发出取消，即便 worker 先一步上报 error，
          // 也必须以「已取消」收尾，绝不能渲染成失败或触发 onUploadError。
          if (options.signal?.aborted) {
            finish({
              success: false,
              skipped: false,
              cancelled: true,
              errorMessage: "上传已取消",
            });
            return;
          }
          finish({
            success: false,
            skipped: false,
            cacheMissing: Boolean(payload.cacheMissing),
            errorMessage: payload.message ?? "Upload failed",
          });
          return;
        }

        if (payload.type === "paused") {
          // D-05 方案 A：Worker 已「软取消 + 回 paused」并中断在途请求。本实例的
          // runUploadTask 收尾，并把该 Worker 直接销毁（不回空闲池）：暂停态下 Worker
          // 内部已无挂起闭包（挂起状态机已删），但续传由主线程重新发起（服务端分片校验
          // 保证字节级续传），无需复用该 Worker，避免残留任务 Map 条目与状态串扰。
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

        if (payload.type === "cancelled") {
          // E2E-R4 修复点：取消后 Worker 的异步 onmessage 调用可能仍在执行，
          // 会继续向主线程投递残留消息（cancelled/debug）。若直接回收复用，
          // 这些残留消息会被「取消→继续」重传时复用的同一 worker.onmessage 槽
          // 错误接收：要么把新任务误判为 cancelled，要么把新任务的 progress/done
          // 丢弃，造成「服务端已合并、客户端卡在上传中」的假死。
          // 因此取消后必须 terminate 而非回池——与 paused 分支保持一致。
          shouldRecycleWorker = false;
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
        chunkCache: options.chunkCache,
        // T-18：按白名单组装，上游对象即使混入额外字段也不会进 Worker 消息。
        // 类型收敛之外再给一道运行时保证（库消费方可能用 JS 调用）。
        networkParams: {
          chunkConcurrency: options.networkParams.chunkConcurrency,
          maxRetries: options.networkParams.maxRetries,
          timeout: options.networkParams.timeout,
          retryInterval: options.networkParams.retryInterval,
        },
        uploadConfig: options.uploadConfig,
      };

      // 注意：File 通过结构化克隆传入 Worker（不转移）。主线程注册表仍持有该引用，
      // 以支持会话内重试；刷新后引用丢失时由分片缓存接管字节来源。
      bumpIdleTimer();
      // T-29：任务已投递给上传 Worker。此点到「首个网络请求」之间就是
      // 上传 Worker 的启动开销 + 秒传预检发起，是首字节固定开销的最后一段。
      markPerf("upload:dispatch");
      worker.postMessage(message);
    });
  };

  const dispose = () => {
    // 先结算在途任务，避免组件卸载后上层 processFileUpload 永久挂在 await 上
    for (const settle of Array.from(taskSettleMap.values())) {
      settle();
    }
    taskSettleMap.clear();

    for (const worker of Array.from(workerPool)) {
      disposeUploadWorker(worker);
    }
    taskWorkerMap.clear();
  };

  return {
    runUploadTask,
    cancelUploadTask,
    pauseUploadTask,
    dispose,
  };
};
