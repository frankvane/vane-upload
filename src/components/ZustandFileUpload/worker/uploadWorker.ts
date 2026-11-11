import { getAllowedHosts } from "../../../shared/urlSafety";
import { joinUrl } from "../../../shared/url";
import { resolveStatusApi } from "../../../shared/uploadApiPaths";
import { deleteCachedChunk, deleteFileCache } from "../services/chunkCacheStore";
import { bindFetchWithRetry, type FetchRetryConfig } from "./fetchWithRetry";
import { createDebugChannel } from "./debugChannel";
import { runChunkPipeline } from "./chunkPipeline";
import {
  ChunkCacheMissError,
  type UploadWorkerMessage,
} from "./uploadWorkerTypes";
import { isBackendUnavailable, isCancellation } from "./errorClassification";

// 每个上传任务的 AbortController（按 fileId 索引），收到 CANCEL 时中断在途请求
const taskAbortControllers = new Map<string, AbortController>();
// 每个上传任务允许携带鉴权头的宿主白名单（F3，SSRF/token 泄漏防护），
// 由 baseURL 推导，随任务开始解析、结束清理。
const taskAllowedHosts = new Map<string, string[]>();
// T-31：同源判定的 origin。lib 构建把 worker 内联成 blob: URL，其 location.origin
// 通常继承创建页；少数运行时返回 "null"，此时从 blob: href 内嵌的 URL 再取一次。
// 模块自身不缓存请求结果，只算一次，避免每个请求都读 location。
const REQUEST_ORIGIN = (() => {
  try {
    const { origin, href } = self.location;
    if (origin && origin !== "null") return origin;
    if (href?.startsWith("blob:")) return new URL(href.slice(5)).origin;
  } catch {
    // 无 location 的测试环境：相对 URL 会被保守拒绝，绝对 URL 白名单路径不受影响
  }
  return undefined;
})();
// 每个上传任务的暂停状态（T3.3）：pause 置 paused=true，分片循环在边界 await 挂起，
// resume 触发 resumeResolver 解除挂起；taskStats 记录续传所需的已传分片数/总分片数。
const taskPauseState = new Map<
  string,
  { paused: boolean; resumeResolver: (() => void) | null }
>();
const taskStats = new Map<
  string,
  { uploadedChunks: number; totalChunks: number }
>();

/**
 * 分片边界安全暂停的挂起原语（T3.3）：在分片任务开始处 await 本函数，
 * pause 消息抵达后本调用将挂起，直到 resume 消息触发 resumeResolver 解除；
 * 暂停期间若收到 cancel（taskSignal abort），同样解除挂起，交由上层以取消收场。
 */
function waitWhilePaused(fileId: string, signal?: AbortSignal): Promise<void> {
  const st = taskPauseState.get(fileId);
  if (!st || !st.paused) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    st.resumeResolver = () => {
      st.resumeResolver = null;
      resolve();
    };
    if (signal) {
      signal.addEventListener(
        "abort",
        () => {
          if (st.resumeResolver) {
            st.resumeResolver = null;
            resolve();
          }
        },
        { once: true },
      );
    }
  });
}

// T-17：调试通道与重试客户端各自成模块；主文件只负责把 Worker 的消息出口接上。
const { debug, setEnabled: setDebugEnabled } = createDebugChannel((message) =>
  self.postMessage(message),
);
const fetchWithRetry = bindFetchWithRetry({
  debug,
  postMessage: (message) => self.postMessage(message),
});




self.onmessage = async (event: MessageEvent<UploadWorkerMessage>) => {
  let fileId: string | undefined;
  // 提升到外层作用域，供两个 catch 判定取消语义。
  let taskSignal: AbortSignal | undefined;
  try {
    debug("Worker 收到消息", { type: event.data.type });

    // 取消任务：中断该文件在途请求并退出循环（P1-8）
    if (event.data.type === "cancel") {
      const { fileId: fid } = event.data;
      const controller = taskAbortControllers.get(fid);
      if (controller && !controller.signal.aborted) {
        controller.abort();
        debug("收到取消指令，已中断上传", { fid }, true);
      }
      taskAllowedHosts.delete(fid);
      // 若正处于暂停挂起，解除等待避免 resume 永不触发
      const pauseSt = taskPauseState.get(fid);
      if (pauseSt && pauseSt.resumeResolver) {
        const resolver = pauseSt.resumeResolver;
        pauseSt.resumeResolver = null;
        resolver();
      }
      taskPauseState.delete(fid);
      taskStats.delete(fid);
      self.postMessage({ type: "cancelled", fileId: fid });
      return;
    }

    // 暂停：仅置标志并确认；分片循环在边界 await 挂起，等待 resume（T3.3）
    if (event.data.type === "pause") {
      const { fileId: fid } = event.data;
      const st = taskPauseState.get(fid);
      if (st) {
        st.paused = true;
        const stats = taskStats.get(fid);
        self.postMessage({
          type: "paused",
          fileId: fid,
          uploadedChunks: stats?.uploadedChunks ?? 0,
          totalChunks: stats?.totalChunks ?? 0,
        });
      }
      return;
    }

    // 继续：解除挂起，分片循环从断点续传（T3.3）
    if (event.data.type === "resume") {
      const { fileId: fid } = event.data;
      const st = taskPauseState.get(fid);
      if (st && st.paused) {
        st.paused = false;
        const resolver = st.resumeResolver;
        st.resumeResolver = null;
        resolver?.();
        self.postMessage({ type: "resumed", fileId: fid });
      }
      return;
    }

    // 只处理上传类型的消息（类型层已被穷尽，运行时仍可能收到未知消息）
    if (event.data.type !== "upload") {
      debug("未知的消息类型", {
        type: (event.data as { type?: string }).type,
      });
      return;
    }

    const { fileInfo, fileRef, chunkCache, networkParams, uploadConfig } =
      event.data;
    fileId = fileInfo.id;
    const authHeaders = uploadConfig?.authHeaders;
    // F3：由 baseURL 推导允许携带鉴权头的宿主白名单（SSRF/token 泄漏防护）
    taskAllowedHosts.set(
      fileInfo.id,
      getAllowedHosts({ baseURL: uploadConfig?.baseURL })
    );
    // 调试日志开关由每次上传任务的配置注入（默认关闭）
    setDebugEnabled(uploadConfig?.debug === true);    // 仅当显式开启 withCredentials（Cookie 鉴权）时才带 'include'，否则 same-origin
    const credentialsMode: RequestCredentials =
      uploadConfig?.withCredentials === true ? "include" : "same-origin";

    // 检查必要参数
    if (!fileInfo) {
      debug("缺少文件信息", event.data as unknown as Record<string, unknown>);
      throw new Error("缺少必要参数：fileInfo");
    }

    // 字节来源：会话内 fileRef 优先；刷新后续传仅由分片缓存提供。
    if (!fileRef && !chunkCache?.instanceId) {
      debug("缺少文件引用与分片缓存", {
        fileId: fileInfo?.id,
        fileName: fileInfo?.fileName,
      });
      throw new Error("缺少必要参数：fileRef 或 chunkCache");
    }

    // 任务级取消信号：CANCEL 消息或主线程 terminate 均可中断全部在途请求（P1-8）
    const taskController = new AbortController();
    taskAbortControllers.set(fileInfo.id, taskController);
    // 初始化暂停状态与续传统计（T3.3）
    taskPauseState.set(fileInfo.id, { paused: false, resumeResolver: null });
    taskSignal = taskController.signal;

    debug("文件信息", {
      fileName: fileInfo.fileName,
      fileSize: fileInfo.fileSize,
      hash: fileInfo.hash,
    });

    // 文件字节只用于分片读取与进度换算：会话内取 fileRef.size，
    // 刷新后续传取持久化的 fileInfo.fileSize（两者一致）。
    const fileSize = fileRef ? fileRef.size : fileInfo.fileSize;
    const chunkSize = fileInfo.chunkSize || 1024 * 1024;
    const chunkCount = Math.ceil(fileSize / chunkSize);
    const cacheKey = chunkCache?.instanceId
      ? { instanceId: chunkCache.instanceId, fileId: fileInfo.id }
      : null;
    taskStats.set(fileInfo.id, { uploadedChunks: 0, totalChunks: chunkCount });
    debug("分片信息", {
      chunkSize,
      chunkCount,
      totalSize: fileSize,
      fromCache: !fileRef,
    });

    // 使用网络参数中的分片并发数和重试参数
    const chunkConcurrency = networkParams?.chunkConcurrency || 2;
    const retryOptions = {
      maxRetries: networkParams?.maxRetries || 3,
      timeout: networkParams?.timeout || 30000,
      retryInterval: networkParams?.retryInterval || 1000,
    };
    debug("网络参数", { chunkConcurrency, ...retryOptions });

    // T-17：公共请求配置只在这里组装一次，四处调用不再各抄一遍。
    const callApi = (
      url: string,
      options: RequestInit,
      extra: FetchRetryConfig = {},
    ): Promise<Response> =>
      fetchWithRetry(url, options, {
        ...retryOptions,
        authHeaders,
        credentials: credentialsMode,
        allowedHosts: taskAllowedHosts.get(fileInfo.id),
        baseOrigin: REQUEST_ORIGIN,
        signal: taskSignal,
        ...extra,
      });

    const baseURL = uploadConfig?.baseURL || "";
    const checkApi = uploadConfig?.checkApi || "/api/file/instant";
    const apiUrl = joinUrl(baseURL, checkApi);
    // T-19：显式 statusApi 优先；未配置时才按 `/instant → /status` 推导，
    // 推导不出来回落内置路径（此时续传退化为「全部重传」，不影响正确性）。
    const statusApi = resolveStatusApi(checkApi, uploadConfig?.statusApi);
    const statusUrl = joinUrl(baseURL, statusApi);

    // E2E-04：预检与状态查询只用作优化，各最多尝试 2 次；
    // 若两次探测都因连接级错误/5xx 失败，说明后端不可用，立即给明确错误，
    // 不再进入分片上传阶段（否则会继续白跑一轮「上传中 0%」）。
    const probeExtra: FetchRetryConfig = {
      maxRetries: Math.min(retryOptions.maxRetries, 2),
    };
    let precheckFailure: unknown = null;

    // P2-1（a）：秒传快路径前置。
    // 旧实现必须先串行算完全部分片 MD5（大文件数千片、数分钟）才发秒传确认，
    // 即便文件早已存在也要白付一轮全量哈希。这里先不带 chunk_md5s 做一次轻量确认：
    // 命中即结束，分片哈希一个都不算。
    let fastData: {
      data?: { uploaded?: boolean; reset?: boolean };
    } | null = null;
    try {
      debug("开始秒传预检（不含分片 MD5）");
      const fastRes = await callApi(
        apiUrl,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            file_id: fileInfo.chunkKey || fileInfo.hash || "",
            md5: fileInfo.hash || "",
            name: fileInfo.fileName,
            size: fileInfo.fileSize,
            total: chunkCount,
            chunk_size: chunkSize,
            hash_mode: uploadConfig.hashMode,
          }),
        },
        probeExtra,
      ).catch((error: unknown) => {
        // 预检失败不改变主流程：后续状态查询会退化为全量重传，
        // 真正的鉴权 / 网络错误会在分片上传阶段照常抛出。
        debug("秒传预检请求失败，继续常规流程", { error: String(error) }, true);
        if (!isCancellation(error, taskSignal)) {
          precheckFailure = error;
        }
        return null;
      });

      fastData = fastRes ? await fastRes.json().catch(() => null) : null;
      if (fastData?.data?.uploaded) {
        debug("文件已秒传（预检命中，跳过全部分片 MD5）", {
          fileName: fileInfo.fileName,
        });
        // 文件已在服务端完整存在，本地分片缓存不再需要。
        if (cacheKey) {
          void deleteFileCache(cacheKey).catch(() => undefined);
        }
        self.postMessage({ type: "done", skipped: true });
        return;
      }
    } catch (error) {
      debug("秒传预检异常，继续常规流程", { error: String(error) }, true);
    }

    // P2-1（b）：不再在首片上传前预计算全部分片 MD5。
    // 先向服务端查询已存在的分片索引（分片内容由 file_id + index 唯一确定），
    // 缺失分片的 MD5 在上传该片时按需计算，首片延迟与文件总片数解耦。
    let existingChunks = new Set<number>();
    // VU-06：状态查询与秒传预检解耦。预检（/instant）因网络抖动失败时
    // fastData 为 null，旧实现会连 /status 都不查，弱网下续传直接退化成全量重传。
    // fastData 现在只用于秒传短路判断；/status 无论预检成败都要尝试一次。
    try {
      const statusQuery = `file_id=${encodeURIComponent(
        fileInfo.chunkKey || fileInfo.hash || "",
      )}&md5=${encodeURIComponent(fileInfo.hash || "")}`;
      const statusRes = await callApi(
        `${statusUrl}?${statusQuery}`,
        { method: "GET" },
        probeExtra,
      );
      const statusData = await statusRes.json().catch(() => null);
      const chunks = statusData?.data?.chunks;
      if (Array.isArray(chunks)) {
        existingChunks = new Set(
          chunks.filter(
            (index: unknown) =>
              Number.isInteger(index) &&
              (index as number) >= 0 &&
              (index as number) < chunkCount,
          ) as number[],
        );
      }
      debug("已存在分片", { count: existingChunks.size });
    } catch (error) {
      // 只有「预检 + 状态查询都失败」才退化为全量重传。
      debug("状态查询失败，按全量重传处理", { error: String(error) }, true);
      // E2E-04：两次探测都是连接级失败/5xx → 后端不可用，立即明确报错，
      // 不再进入分片上传白跑一轮。
      if (
        !isCancellation(error, taskSignal) &&
        isBackendUnavailable(error) &&
        precheckFailure !== null &&
        isBackendUnavailable(precheckFailure)
      ) {
        self.postMessage({
          type: "error",
          message:
            "无法连接服务器（网络错误或后端不可用），请检查网络后重试上传",
        });
        return;
      }
    }

    // VU-49：不再物化 `needUploadChunks` 数组与等量的任务闭包。
    // existingChunks 已过滤为 [0, chunkCount) 内的有效索引，因此缺失数可直接相减；
    // 上传时用共享游标跳过已存在的索引，内存占用与分片数无关。
    const missingCount = chunkCount - existingChunks.size;
    debug("需要上传的分片", {
      count: missingCount,
      // 大文件有数千个索引，只打印区间，绝不把数组塞进日志 / 环形缓冲。
      range: `0..${Math.max(0, chunkCount - 1)}`,
    });

    // 服务端已存在的分片无需本地字节，顺手回收其缓存（刷新临界点可能残留）。
    if (cacheKey && existingChunks.size > 0) {
      for (const index of existingChunks) {
        void deleteCachedChunk(cacheKey, index).catch(() => undefined);
      }
    }

    try {
      await runChunkPipeline({
        fileInfo,
        fileRef,
        cacheKey,
        fileSize,
        chunkSize,
        chunkCount,
        existingChunks,
        missingCount,
        baseURL,
        uploadApi: uploadConfig?.uploadApi || "/api/file/upload",
        mergeApi: uploadConfig?.mergeApi || "/api/file/merge",
        hashMode: uploadConfig.hashMode,
        request: callApi,
        chunkConcurrency,
        signal: taskSignal!,
        taskStats,
        isPaused: () => taskPauseState.get(fileInfo.id)?.paused === true,
        waitWhilePaused,
        debug,
        postMessage: (message) => self.postMessage(message),
      });
    } catch (error) {
      // VU-07：取消时在途 fetch 抛 AbortError，旧实现统一上报 error，
      // 与主线程的 cancelled 收尾形成竞态，UI 可能显示「失败」。
      if (isCancellation(error, taskSignal)) {
        self.postMessage({ type: "cancelled", fileId: fileId ?? "" });
      } else if (error instanceof ChunkCacheMissError) {
        self.postMessage({
          type: "error",
          message: `本地续传缓存缺失（分片 ${error.chunkIndex + 1}），请重新选择文件后继续上传`,
          cacheMissing: true,
        });
      } else {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        debug("上传过程中出现致命错误", { error: errorMessage }, true);
        self.postMessage({
          type: "error",
          message: errorMessage,
        });
      }
    } finally {
      // 任务结束（成功/失败/取消）后释放 AbortController 与暂停状态，避免 Map 残留
      if (fileId) {
        taskAbortControllers.delete(fileId);
        taskPauseState.delete(fileId);
        taskStats.delete(fileId);
        taskAllowedHosts.delete(fileId);
      }
    }
  } catch (error) {
    // Worker 执行过程中的全局错误处理（同样要区分取消）
    if (isCancellation(error, taskSignal)) {
      self.postMessage({ type: "cancelled", fileId: fileId ?? "" });
      return;
    }
    const errorMessage = error instanceof Error ? error.message : String(error);
    debug("Worker 执行错误", { error: errorMessage }, true);
    self.postMessage({
      type: "error",
      message: errorMessage,
    });
  }
};

// VU-49：并发控制已迁至 shared/concurrency.ts 的 runCursorPool（游标式，
// 不预物化任务数组）；主线程与预处理 Worker 共用同一实现，避免两套语义漂移。
