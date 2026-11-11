/**
 * 分片上传与合并（T-17：从 uploadWorker.ts 的 onmessage 主体抽出，约 270 行）。
 *
 * 原先这段深埋在 `self.onmessage` 闭包里，隐式读写十几个外层变量；现在所有依赖
 * 都通过 {@link ChunkPipelineContext} 显式传入。语义**一字未改**：游标式并发池、
 * 分片边界安全暂停、缓存缺片专用错误、连接级失败快速收口、进度字节级换算、
 * 合并成功后清缓存，全部照旧；内部 `return` 表示「已上报终态，任务结束」。
 */
import { debugError } from "../../../shared/debugLogger";
import { runCursorPool } from "../../../shared/concurrency";
import SparkMD5 from "spark-md5";
import type { UploadHashMode } from "../types/upload";
import { computeUploadProgress } from "../services/uploadProgress";
import {
  deleteCachedChunk,
  deleteFileCache,
  readCachedChunk,
} from "../services/chunkCacheStore";
import { joinUrl } from "../../../shared/url";
import type { FetchRetryConfig } from "./fetchWithRetry";
import type { WorkerDebug } from "./debugChannel";
import { ChunkCacheMissError } from "./uploadWorkerTypes";
import { isCancellation, isConnectionFailure } from "./errorClassification";

export interface ChunkPipelineFileInfo {
  id: string;
  fileName: string;
  fileSize: number;
  hash?: string;
  chunkKey?: string;
}

export interface ChunkPipelineContext {
  fileInfo: ChunkPipelineFileInfo;
  fileRef?: File;
  cacheKey: { instanceId: string; fileId: string } | null;
  fileSize: number;
  chunkSize: number;
  chunkCount: number;
  existingChunks: Set<number>;
  missingCount: number;
  baseURL: string;
  uploadApi: string;
  mergeApi: string;
  hashMode?: UploadHashMode;
  /** 由主文件绑定好公共配置（鉴权 / 白名单 / 取消信号）的请求函数 */
  request: (
    url: string,
    options: RequestInit,
    extra?: FetchRetryConfig,
  ) => Promise<Response>;
  chunkConcurrency: number;
  signal: AbortSignal;
  taskStats: Map<string, { uploadedChunks: number; totalChunks: number }>;
  debug: WorkerDebug;
  postMessage: (message: unknown) => void;
}

function calculateMD5(buffer: ArrayBuffer, debug: WorkerDebug): string {
  debug("开始计算MD5");
  const spark = new SparkMD5.ArrayBuffer();
  spark.append(buffer);
  const result = spark.end();
  debug("MD5计算完成", { result });
  return result;
}

export async function runChunkPipeline(ctx: ChunkPipelineContext): Promise<void> {
  const {
    fileInfo,
    fileRef,
    cacheKey,
    fileSize,
    chunkSize,
    chunkCount,
    existingChunks,
    missingCount,
    baseURL,
    uploadApi,
    mergeApi,
    hashMode,
    request,
    chunkConcurrency,
    signal,
    taskStats,
    debug,
    postMessage,
  } = ctx;

  // 记录已完成的分片数量，用于计算进度
  let totalUploadedChunks = chunkCount - missingCount;
  const failedChunks: number[] = [];
  // E2E-04：首个「连接级失败 / 5xx 已耗尽重试」的分片错误。
  // 一旦命中就停止领取新分片，避免后端不可用时把剩余分片全部再跑一遍。
  let fatalChunkError: unknown = null;
  // 刷新后续传时本地缓存缺片：记录首个缺失索引，最终以「需重新选择文件」上报
  let cacheMissingIndex: number | null = null;

  // 3. 分片上传 - 游标式并发池
  if (missingCount > 0) {
    debug("开始分片上传");
    // 上传阶段计时起点，用于推导速率/剩余时间（T3.4）
    const uploadStartTime = Date.now();
    let cursor = 0;
    const nextChunk = (): number | undefined => {
      while (cursor < chunkCount) {
        const index = cursor;
        cursor += 1;
        if (!existingChunks.has(index)) return index;
      }
      return undefined;
    };

    const uploadChunk = async (i: number) => {
      // 字节来源：会话内 fileRef 按需 slice；刷新后续传从分片缓存读取。
      // 缓存缺片时抛出专用错误，避免被当成普通网络失败。
      const readChunk = async (): Promise<ArrayBuffer> => {
        if (fileRef) {
          const start = i * chunkSize;
          const end = Math.min(fileRef.size, start + chunkSize);
          return fileRef.slice(start, end).arrayBuffer();
        }
        if (cacheKey) {
          const cached = await readCachedChunk(cacheKey, i);
          if (cached) {
            return cached;
          }
        }
        if (cacheMissingIndex === null) {
          cacheMissingIndex = i;
        }
        throw new ChunkCacheMissError(i);
      };
      const chunkBuf = await readChunk();
      // P2-1：按需计算——只算当前要上传的分片，不再预计算全部分片
      const chunkMd5 = calculateMD5(chunkBuf, debug);

      const formData = new FormData();
      formData.append("file_id", fileInfo.chunkKey || fileInfo.hash || "");
      formData.append("index", i.toString());
      formData.append("chunk", new Blob([chunkBuf]));
      formData.append("total", chunkCount.toString());
      formData.append("chunk_md5", chunkMd5);

      debug(`上传分片 ${i + 1}/${chunkCount}`, { size: chunkBuf.byteLength });
      try {
        // 使用配置的上传 API 地址
        const uploadUrl = joinUrl(baseURL, uploadApi);
        debug(`分片上传URL: ${uploadUrl}`);

        await request(uploadUrl, { method: "POST", body: formData });

        // 服务端已确认该分片：立即释放对应缓存，占用随进度下降。
        if (cacheKey) {
          void deleteCachedChunk(cacheKey, i).catch(() => undefined);
        }

        // 更新进度
        totalUploadedChunks++;
        const stats = taskStats.get(fileInfo.id);
        if (stats) {
          stats.uploadedChunks = totalUploadedChunks;
        }
        const uploadedBytes = Math.min(
          totalUploadedChunks * chunkSize,
          fileSize,
        );
        const elapsedMs = Math.max(1, Date.now() - uploadStartTime);
        const detail = computeUploadProgress({
          uploadedBytes,
          totalBytes: fileSize,
          elapsedMs,
        });
        debug(`分片 ${i + 1} 上传成功，总进度: ${detail.progress}%`);

        postMessage({
          type: "progress",
          progress: detail.progress,
          uploadedBytes: detail.uploadedBytes,
          totalBytes: detail.totalBytes,
          speed: detail.speed,
          eta: detail.eta,
          chunkIndex: i,
        });
      } catch (error) {
        debug(
          `分片 ${i + 1} 上传失败`,
          { error: error instanceof Error ? error.message : String(error) },
          true,
        );
        debugError(`分片 ${i + 1} 上传失败:`, error);
        // E2E-04：连接级失败不再继续上传剩余分片（由 shouldStop 终止游标池），
        // 保留首个错误用于向上报可读原因。
        if (
          fatalChunkError === null &&
          !isCancellation(error, signal) &&
          isConnectionFailure(error)
        ) {
          fatalChunkError = error;
        }
        // 失败索引由 pool 的 onFailure 统一记录，这里继续抛出以计入 failed。
        throw error;
      }
    };

    // VU-49：只启动 chunkConcurrency 个 runner，按游标领取下一个缺失分片。
    debug("执行并发上传任务", {
      tasks: missingCount,
      concurrency: chunkConcurrency,
    });
    await runCursorPool({
      next: nextChunk,
      concurrency: chunkConcurrency,
      task: uploadChunk,
      // 取消后不再领取新分片；缓存缺片后同样停止领取（剩余分片已无法读取）；
      // 连接级失败/5xx 后停止领取，尽快把明确错误抛给 UI（E2E-04）。
      shouldStop: () =>
        signal.aborted === true ||
        cacheMissingIndex !== null ||
        fatalChunkError !== null,
      onFailure: (index) => {
        failedChunks.push(index);
      },
    });
    // VU-07：在途请求被 CANCEL 中断后会记入 failedChunks。
    // 必须在这里先按取消收尾，否则下面的「分片上传失败」分支会先发 error，
    // 与主线程的 cancelled 收尾形成竞态，UI 显示失败并触发 onUploadError。
    if (signal.aborted) {
      postMessage({ type: "cancelled", fileId: fileInfo.id });
      return;
    }
    debug("并发上传任务完成", { failedChunks: failedChunks.length });

    // 刷新后续传时本地缓存缺片：明确上报「需重新选择文件」，
    // 不能混在普通分片失败里，否则用户会以为只是网络问题。
    if (cacheMissingIndex !== null) {
      postMessage({
        type: "error",
        message: `本地续传缓存缺失（分片 ${cacheMissingIndex + 1}/${chunkCount}），请重新选择文件后继续上传`,
        cacheMissing: true,
      });
      return;
    }

    // E2E-04：连接级失败时优先上报可读原因，不再用「N 个分片失败」的模糊文案；
    // 此时正常情况下只有一个在途批次被计入失败。
    if (fatalChunkError !== null) {
      postMessage({
        type: "error",
        message:
          "无法连接服务器（网络错误或后端不可用），请检查网络后重试上传",
        failedChunks,
      });
      return;
    }

    // 如果有失败的分片，报告错误
    if (failedChunks.length > 0) {
      debug(
        "有分片上传失败",
        { count: failedChunks.length, chunks: failedChunks },
        true,
      );
      postMessage({
        type: "error",
        message: `有 ${failedChunks.length} 个分片上传失败，请重试上传`,
        failedChunks,
      });
      return;
    }
  } else {
    debug("没有需要上传的分片");
  }

  // 4. 合并
  debug("开始合并文件");
  const mergeRequestBody = {
    file_id: fileInfo.chunkKey || fileInfo.hash || "",
    md5: fileInfo.hash || "",
    name: fileInfo.fileName,
    size: fileInfo.fileSize,
    total: chunkCount,
    hash_mode: hashMode,
  };
  debug("合并请求体", mergeRequestBody);

  const mergeUrl = joinUrl(baseURL, mergeApi);
  debug(`合并文件URL: ${mergeUrl}`);

  await request(mergeUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(mergeRequestBody),
  });
  debug("文件合并成功");

  // 合并落盘即完成：清空该文件的全部分片缓存，避免留下垃圾。
  if (cacheKey) {
    void deleteFileCache(cacheKey).catch(() => undefined);
  }
  postMessage({ type: "done", skipped: false });
}
