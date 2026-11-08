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
): Promise<{ uploadFiles: PreparedFile[]; stats: FilePrepareStats }> => {
  const chunkSize = options.chunkSize || 1024 * 1024;
  const hashMode: UploadHashMode =
    options.hashMode === "sample" ? "sample" : "full";
  const computeHash = options.hashFile ?? hashFile;
  const total = files.length;
  const oversized = 0;
  let processed = 0;
  let success = 0;
  let failed = 0;

  const emitProgress = (payload: ProgressPayload) => options.onProgress?.(payload);

  const results = await mapWithConcurrency<File, PreparedFile>(
    files,
    HASH_CONCURRENCY,
    async (file, i) => {
      try {
        processed += 1;
        const hash = await computeHash(file, hashMode);
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
  };
};

self.onmessage = async (e: MessageEvent<FilePrepareRequest>) => {
  const { uploadFiles, stats } = await prepareFiles(e.data.files, {
    chunkSize: e.data.networkParams?.chunkSize,
    hashMode: e.data.hashMode,
    onProgress: (payload) => self.postMessage(payload),
  });

  self.postMessage({ type: "complete", uploadFiles, stats });
};
