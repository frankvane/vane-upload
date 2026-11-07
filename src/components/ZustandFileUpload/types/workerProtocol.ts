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
       * 文件引用（T3.1 流式分片）：替代原 fileBuffer 整文件传输。
       * File/Blob 可结构化克隆进 Worker，分片按需 slice 读取，
       * 内存驻留 = chunkSize × chunkConcurrency，与文件大小无关。
       */
      fileRef: File;
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
      /** 暂停指定文件的上传任务（T3.3）：分片边界安全暂停，Worker 挂起等待 resume */
      type: "pause";
      fileId: string;
    }
  | {
      /** 继续指定文件的上传任务（T3.3）：解除 Worker 挂起，从断点续传 */
      type: "resume";
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
    }
  | {
      /** 继续确认（T3.3）：Worker 已解除挂起并从断点续传 */
      type: "resumed";
      fileId: string;
    };

