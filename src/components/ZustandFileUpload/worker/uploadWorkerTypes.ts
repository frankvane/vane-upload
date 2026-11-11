/**
 * 上传 Worker 的消息协议（T-17：从 uploadWorker.ts 抽出，纯类型搬迁）。
 */
import type { UploadHashMode } from "../types/upload";

export type UploadWorkerMessage =
  | {
      type: "upload";
      fileInfo: {
        id: string;
        fileName: string;
        fileSize: number;
        hash?: string;
        chunkSize?: number;
        /** 分片存储键（服务端 file_id）：`${md5}_${size}_${chunkSize}`，见 shared/chunkKey.ts */
        chunkKey?: string;
      };
      /**
       * 文件引用（T3.1 流式分片）：File 结构化克隆进 Worker，按需 slice 读取。
       * 刷新后续传时为空，改由 chunkCache 提供分片字节。
       */
      fileRef?: File;
      /**
       * 分片缓存（方案 A）：fileRef 缺失时 Worker 从 IndexedDB 读取尚未确认的分片
       * 分片上传成功后删除对应缓存。
       */
      chunkCache?: {
        instanceId: string;
      };
      networkParams?: {
        chunkConcurrency?: number;
        maxRetries?: number;
        timeout?: number;
        retryInterval?: number;
      };
      uploadConfig: {
        baseURL: string;
        uploadApi: string;
        checkApi: string;
        mergeApi: string;
        /** T-19：显式续传状态接口；缺省时按 checkApi 的命名约定推导 */
        statusApi?: string;
        authHeaders?: Record<string, string>;
        /** 是否携带 Cookie（credentials:'include'）。默认 false（same-origin） */
        withCredentials?: boolean;
        /** 调试日志开关：默认 false，关闭时 Worker 内不产生任何日志输出 */
        debug?: boolean;
        /** 文件哈希模式：sample 时服务端合并跳过全量 md5 强校验（分片级校验保留） */
        hashMode?: UploadHashMode;
      };
    }
  | {
      type: "cancel";
      fileId: string;
    }
  | {
      /** 暂停指定文件的上传任务（D-05 方案 A）：中断在途请求并回 paused，由主线程重跑续传 */
      type: "pause";
      fileId: string;
    };

/**
 * 刷新后续传时本地分片缓存缺片：属于「需重新选择文件」，
 * 上层必须据此把记录置为 awaitingReselect，而不是普通上传失败。
 */
export class ChunkCacheMissError extends Error {
  constructor(readonly chunkIndex: number) {
    super(`本地续传缓存缺少分片 ${chunkIndex + 1}`);
    this.name = "ChunkCacheMissError";
  }
}
