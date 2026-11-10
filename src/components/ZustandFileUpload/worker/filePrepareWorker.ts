import SparkMD5 from "spark-md5";
import { buildQueueId } from "../../../shared/fileId";
import { mapWithConcurrency } from "../../../shared/concurrency";
import {
  UploadStatus,
  type UploadHashMode,
  type UploadFile,
} from "../types/upload";
import { debugError } from "./../../../shared/debugLogger";

/** 全量流式哈希的读取块大小：内存驻留上限，与文件大小无关 */
const FULL_HASH_READ_BLOCK = 1024 * 1024; // 1MB
/** 采样哈希的采样块大小 */
const SAMPLE_BLOCK = 4 * 1024 * 1024; // 4MB
/** 采样哈希的中间采样点数量（不含首尾块） */
const SAMPLE_MIDDLE_POINTS = 3;
/**
 * VU-43：哈希是彼此独立的 IO，用受控并发池替代逐文件串行 await。
 * 2 是保守值：每个大文件内部已按 1MB 顺序读，并发过高会放大磁盘争用与内存峰值。
 */
export const HASH_CONCURRENCY = 2;

/**
 * T-29：Worker 内部阶段耗时（毫秒），随 complete 消息回传主线程做首字节归因。
 *
 * 为什么在 Worker 里记而不是主线程：Worker 有自己的 `performance` timeline，
 * 主线程只能看到「创建 Worker」与「收到 complete」两个点，中间的「脚本加载」
 * 与「哈希计算」无法区分。Worker 侧 `performance.now()` 的原点是 worker 环境
 * 创建时刻（`performance.timeOrigin`），所以模块体第一行读到的值 ≈
 * 「worker 创建 → 我们的代码开始跑」，这一段正是模块图 fetch + 编译的开销。
 */
export interface FilePrepareTimings {
  /** worker 创建 → 模块体开始执行（≈ 模块图 fetch + 编译 + 求值） */
  boot: number;
  /** 模块体执行完 → 收到首条 message（正常应 ≈ 0，异常偏大说明主线程排队） */
  waitForMessage: number;
  /** 首片哈希开始 → 末片哈希结束（并发 >1 时为整批窗口，不是逐文件累加） */
  hash: number;
}

const nowMs = (): number => {
  try {
    return performance.now();
  } catch {
    return 0;
  }
};

/** 本模块求值时刻（相对 worker 创建）。模块 body 执行时 import 图已完成加载。 */
const WORKER_MODULE_READY_AT = nowMs();

interface FilePrepareRequest {
  files: File[];
  networkParams?: {
    chunkSize?: number;
  };
  /** 哈希模式（T3.1）：full=全量流式（默认），sample=采样 */
  hashMode?: UploadHashMode;
}

type PreparedFile = UploadFile & { fileRef: File };

interface ProgressPayload {
  type: "progress";
  processed: number;
  total: number;
  success: number;
  failed: number;
  oversized: number;
  fileDetails: {
    id: string;
    fileName: string;
    fileSize: number;
    fileType: string;
    index: number;
    total: number;
    error?: boolean;
    errorMessage?: string;
  };
}

export interface FilePrepareStats {
  processed: number;
  total: number;
  success: number;
  failed: number;
  oversized: number;
}

export interface PrepareFilesOptions {
  chunkSize?: number;
  hashMode?: UploadHashMode;
  /** 可注入哈希实现，便于在单测里确定性地验证并发时序。 */
  hashFile?: (file: File, mode: UploadHashMode) => Promise<string>;
  onProgress?: (payload: ProgressPayload) => void;
}

/**
 * 全量流式哈希（T3.1）：按 1MB 顺序 slice 读入并增量喂给 spark-md5，
 * 任一时刻内存驻留不超过一个读取块；替代原 `file.arrayBuffer()` 整文件读入
 * （2GB 文件旧实现峰值内存 ≈ 文件大小 + ArrayBuffer 拷贝）。
 */
async function hashFileFull(file: File): Promise<string> {
  const spark = new SparkMD5.ArrayBuffer();
  for (let start = 0; start < file.size; start += FULL_HASH_READ_BLOCK) {
    const end = Math.min(file.size, start + FULL_HASH_READ_BLOCK);
    const block = await file.slice(start, end).arrayBuffer();
    spark.append(block);
  }
  return spark.end();
}

/**
 * 采样哈希（T3.1）：首 4MB + 中间 3 个 4MB 采样点 + 尾 4MB + 文件大小。
 * 小文件（<= 2 个采样块）退化为全量读取 + size，保证确定性。
 * 注意：采样碰撞（同大小且采样区一致的不同文件）会被视为同一文件，
 * 服务端合并时退化为大小 + 逐分片 md5 校验；秒传判定存在极低概率误命中，
 * 对完整性敏感的场景请使用 full 模式。
 */
async function hashFileSample(file: File): Promise<string> {
  const spark = new SparkMD5.ArrayBuffer();

  const appendRange = async (start: number, end: number) => {
    const from = Math.max(0, Math.min(start, file.size));
    const to = Math.max(0, Math.min(end, file.size));
    if (to <= from) {
      return;
    }
    const block = await file.slice(from, to).arrayBuffer();
    spark.append(block);
  };

  if (file.size <= SAMPLE_BLOCK * 2) {
    // 小文件：直接全量（读取成本可忽略），再并入 size 保证与 full 模式区分
    await appendRange(0, file.size);
  } else {
    await appendRange(0, SAMPLE_BLOCK);
    for (let point = 1; point <= SAMPLE_MIDDLE_POINTS; point++) {
      const center = Math.floor(
        (file.size * point) / (SAMPLE_MIDDLE_POINTS + 1),
      );
      await appendRange(center - SAMPLE_BLOCK / 2, center + SAMPLE_BLOCK / 2);
    }
    await appendRange(file.size - SAMPLE_BLOCK, file.size);
  }

  // size 参与哈希：不同大小的文件即使采样区一致也不碰撞
  // 注意：ArrayBuffer 版 append 只接受 ArrayBuffer，字符串需先编码为字节
  spark.append(
    new TextEncoder().encode(`size:${file.size}`).buffer as ArrayBuffer,
  );
  return spark.end();
}

const hashFile = (file: File, mode: UploadHashMode): Promise<string> =>
  mode === "sample" ? hashFileSample(file) : hashFileFull(file);

/**
 * VU-43：受控并发哈希 + 按原 index 归并。
 * 单个文件失败只影响该文件，其余继续；返回数组仍按选择顺序排列（order = index）。
 */
export const prepareFiles = async (
  files: File[],
  options: PrepareFilesOptions = {},
): Promise<{
  uploadFiles: PreparedFile[];
  stats: FilePrepareStats;
  timings: { hash: number };
}> => {
  const chunkSize = options.chunkSize || 1024 * 1024;
  const hashMode: UploadHashMode =
    options.hashMode === "sample" ? "sample" : "full";
  const computeHash = options.hashFile ?? hashFile;
  const total = files.length;
  const oversized = 0;
  let processed = 0;
  let success = 0;
  let failed = 0;
  // T-29：整批哈希窗口（并发下是「首片开始 → 末片结束」，不是逐文件累加）
  let hashWindowStart = -1;
  let hashWindowEnd = -1;

  const emitProgress = (payload: ProgressPayload) => options.onProgress?.(payload);

  const results = await mapWithConcurrency<File, PreparedFile>(
    files,
    HASH_CONCURRENCY,
    async (file, i) => {
      try {
        processed += 1;
        if (hashWindowStart < 0) {
          hashWindowStart = nowMs();
        }
        const hash = await computeHash(file, hashMode);
        hashWindowEnd = nowMs();
        // 队列 id 含随机后缀：同内容文件不再互相覆盖（P1-7）
        const id = buildQueueId(hash, file.size, file.lastModified);

        emitProgress({
          type: "progress",
          processed,
          total,
          success,
          failed,
          oversized,
          // VU-17：进度消息带上 id，供主线程以 id 作计时键（避免同名文件碰撞）
          fileDetails: {
            id,
            fileName: file.name,
            fileSize: file.size,
            fileType: file.type,
            index: i + 1,
            total,
          },
        });

        const uploadFile: PreparedFile = {
          id,
          fileName: file.name,
          fileSize: file.size,
          fileType: file.type,
          lastModified: file.lastModified,
          status: UploadStatus.QUEUED,
          progress: 0,
          hash,
          chunkSize,
          chunkCount: Math.ceil(file.size / chunkSize),
          uploadedChunks: 0,
          pausedChunks: [],
          createdAt: Date.now(),
          order: i,
          hashMode,
          // 文件引用回传主线程注册表（T3.1）：不整文件序列化，
          // File 结构化克隆为句柄，主线程据此在上传时按需切片
          fileRef: file,
        };
        success += 1;
        return uploadFile;
      } catch (error) {
        debugError("Error processing file:", error);
        failed += 1;
        emitProgress({
          type: "progress",
          processed,
          total,
          success,
          failed,
          oversized,
          fileDetails: {
            id: "",
            fileName: file.name,
            fileSize: file.size,
            fileType: file.type,
            index: i + 1,
            total,
            error: true,
            errorMessage: error instanceof Error ? error.message : String(error),
          },
        });
        return undefined;
      }
    },
  );

  const uploadFiles = results.filter(
    (file): file is PreparedFile => file !== undefined,
  );

  return {
    uploadFiles,
    stats: { processed, total, success, failed, oversized },
    timings: {
      hash:
        hashWindowStart >= 0 && hashWindowEnd >= hashWindowStart
          ? Math.round(hashWindowEnd - hashWindowStart)
          : 0,
    },
  };
};

self.onmessage = async (e: MessageEvent<FilePrepareRequest>) => {
  const messageAt = nowMs();
  const { uploadFiles, stats, timings } = await prepareFiles(e.data.files, {
    chunkSize: e.data.networkParams?.chunkSize,
    hashMode: e.data.hashMode,
    onProgress: (payload) => self.postMessage(payload),
  });

  self.postMessage({
    type: "complete",
    uploadFiles,
    stats,
    // T-29：首字节归因用的分段耗时，主线程在埋点开启时才会消费
    timings: {
      boot: Math.round(WORKER_MODULE_READY_AT),
      waitForMessage: Math.round(messageAt - WORKER_MODULE_READY_AT),
      hash: timings.hash,
    } satisfies FilePrepareTimings,
  });
};
