/**
 * 上传 Worker 的消息协议（T-17：从 uploadWorker.ts 抽出，纯类型搬迁）。
 */
import type { WorkerNetworkParams, WorkerUploadConfig } from "../types/upload";

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
      // T-58：复用共享 WorkerNetworkParams（与 UploadWorkerRequest 同源，不再漂移）。
      networkParams?: WorkerNetworkParams;
      // T-58：复用共享 WorkerUploadConfig（与 UploadWorkerRequest 同源，含 statusApi）。
      uploadConfig: WorkerUploadConfig;
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
