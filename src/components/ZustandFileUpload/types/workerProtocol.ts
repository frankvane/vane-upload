import type { UploadHashMode } from "./upload";

export type UploadWorkerRequest =
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
       * 文件引用（T3.1 流式分片）：会话内存在时优先按需 slice 读取，
       * 不做整文件传输。页面刷新后为 undefined，此时必须提供
       * {@link UploadWorkerRequest} 的 chunkCache，由 Worker 从分片缓存读取字节。
       */
      fileRef?: File;
      /**
       * 分片缓存（方案 A）：fileRef 缺失时的字节来源。
       * Worker 通过同一 IndexedDB（`react-upload-chunks`）读取尚未确认成功的分片，
       * 并在分片上传成功后删除对应缓存，使占用随进度下降。
       */
      chunkCache?: {
        instanceId: string;
      };
      networkParams?: {
        networkType?: string;
        fileConcurrency?: number;
        chunkConcurrency?: number;
        chunkSize?: number;
        maxRetries?: number;
        timeout?: number;
        retryInterval?: number;
      };
      uploadConfig: {
        baseURL: string;
        uploadApi: string;
        checkApi: string;
        mergeApi: string;
        /** 鉴权请求头（已在主线程解析好，序列化传入 Worker） */
        authHeaders?: Record<string, string>;
        /** 是否携带 Cookie（credentials:'include'）。默认 false（same-origin）：
         *  跨域 Bearer 头鉴权不触发 CORS credentials 强校验；仅同域/跨域
         *  Cookie 鉴权时显式开启，且服务端需返回
         *  Access-Control-Allow-Credentials:true。 */
        withCredentials?: boolean;
        /** 调试日志开关：默认 false，关闭时 Worker 内不产生任何日志输出 */
        debug?: boolean;
        /** 文件哈希模式：sample 时服务端合并跳过全量 md5 强校验（分片级校验保留） */
        hashMode?: UploadHashMode;
      };
    }
  | {
      /** 取消指定文件的上传任务：Worker 内 AbortController.abort() 中断在途请求 */
      type: "cancel";
      fileId: string;
    }
  | {
      /** 暂停指定文件的上传任务（D-05 方案 A）：中断在途请求并回 paused，由主线程重跑续传 */
      type: "pause";
      fileId: string;
    };

export type UploadWorkerResponse =
  | {
      type: "debug";
      message: string;
      data?: Record<string, unknown>;
    }
  | {
      type: "progress";
      /** 整体百分比 [0-100] */
      progress: number;
      /** 已上传字节数（T3.4 字节级进度） */
      uploadedBytes: number;
      /** 文件总字节数 */
      totalBytes: number;
      /** 瞬时速率（字节/秒，T3.4） */
      speed: number;
      /** 预计剩余时间（秒，T3.4） */
      eta: number;
      chunkIndex?: number;
    }
  | {
      type: "done";
      skipped?: boolean;
    }
  | {
      type: "error";
      message?: string;
      failedChunks?: number[];
      /**
       * 分片缓存缺失（刷新后续传时字节已不存在）。
       * 主线程据此把记录置为「需重新选择文件」，而不是普通上传失败。
       */
      cacheMissing?: boolean;
    }
  | {
      type: "retry";
      error?: string;
      attemptNumber?: number;
      retriesLeft?: number;
      message?: string;
    }
  | {
      /** 取消完成确认：Worker 已中断该文件的在途请求 */
      type: "cancelled";
      fileId: string;
    }
  | {
      /** 暂停确认（T3.3）：Worker 已在分片边界挂起，等待 resume */
      type: "paused";
      fileId: string;
      /** 已上传分片数（用于 pausedChunks 记录与展示） */
      uploadedChunks: number;
      /** 总分片数 */
      totalChunks: number;
    };

