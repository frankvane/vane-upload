import SparkMD5 from "spark-md5";
import { buildQueueId } from "../../../shared/fileId";
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

interface FilePrepareRequest {
  files: File[];
  networkParams?: {
    chunkSize?: number;
  };
  /** 哈希模式（T3.1）：full=全量流式（默认），sample=采样 */
  hashMode?: UploadHashMode;
}

/**
 * @typedef {Object} NetworkParams
 * @property {number} chunkSize - 分片大小
 */

/**
 * @typedef {Object} UploadFile
 * @property {string} id
 * @property {string} fileName
 * @property {number} fileSize
 * @property {string} fileType
 * @property {number} lastModified
 * @property {string} status
 * @property {number} progress
 * @property {string=} hash
 * @property {number=} chunkSize
 * @property {number=} chunkCount
 * @property {number=} uploadedChunks
 * @property {number[]=} pausedChunks
 * @property {string=} errorMessage
 * @property {number} createdAt
 * @property {number} order
 * @property {File=} fileRef - 运行时文件引用（回传主线程入注册表，不持久化）
 * @property {string=} hashMode
 */

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

self.onmessage = async (e: MessageEvent<FilePrepareRequest>) => {
  const files = e.data.files;
  // 从传入的网络参数中获取分片大小，如果没有则使用默认值
  const networkParams = e.data.networkParams || {};
  const CHUNK_SIZE = networkParams.chunkSize || 1024 * 1024; // 默认1MB
  // 哈希模式：默认全量流式（T3.1）
  const hashMode: UploadHashMode =
    e.data.hashMode === "sample" ? "sample" : "full";

  // 记录处理进度
  let processed = 0;
  const total = files.length;
  let success = 0;
  let failed = 0;
  const oversized = 0;

  const uploadFiles: Array<UploadFile & { fileRef: File }> = [];
  for (let i = 0; i < files.length; i++) {
    try {
      const file = files[i]!;
      const chunkSize = CHUNK_SIZE;
      const chunkCount = Math.ceil(file.size / chunkSize);

      // 发送进度更新，包含当前处理的文件信息
      processed++;
      self.postMessage({
        type: "progress",
        processed,
        total,
        success,
        failed,
        oversized,
        fileDetails: {
          fileName: file.name,
          fileSize: file.size,
          fileType: file.type,
          index: i + 1,
          total: files.length,
        },
      });

      const hash = await hashFile(file, hashMode);
      // 队列 id 含随机后缀：同内容文件不再互相覆盖（P1-7）
      const id = buildQueueId(hash, file.size, file.lastModified);

      const uploadFile: UploadFile & { fileRef: File } = {
        id,
        fileName: file.name,
        fileSize: file.size,
        fileType: file.type,
        lastModified: file.lastModified,
        status: UploadStatus.QUEUED,
        progress: 0,
        hash,
        chunkSize,
        chunkCount,
        uploadedChunks: 0,
        pausedChunks: [],
        createdAt: Date.now(),
        order: i,
        hashMode,
        // 文件引用回传主线程注册表（T3.1）：不整文件序列化，
        // File 结构化克隆为句柄，主线程据此在上传时按需切片
        fileRef: file,
      };
      uploadFiles.push(uploadFile);
      success++;
    } catch (error) {
      debugError("Error processing file:", error);
      failed++;

      // 发送错误文件的信息
      const failedFile = files[i];
      if (failedFile) {
        self.postMessage({
          type: "progress",
          processed,
          total,
          success,
          failed,
          oversized,
          fileDetails: {
            fileName: failedFile.name,
            fileSize: failedFile.size,
            fileType: failedFile.type,
            index: i + 1,
            total: files.length,
            error: true,
            errorMessage:
              error instanceof Error ? error.message : String(error),
          },
        });
      }
    }
  }

  // 发送完成信息
  self.postMessage({
    type: "complete",
    uploadFiles,
    stats: {
      processed,
      total,
      success,
      failed,
      oversized,
    },
  });
};
