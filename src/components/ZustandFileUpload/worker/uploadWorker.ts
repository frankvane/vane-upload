import { debugError, debugLog } from "./../../../shared/debugLogger";

import SparkMD5 from "spark-md5";
import type { UploadHashMode } from "../types/upload";
import { computeUploadProgress } from "../services/uploadProgress";
import { joinUrl } from "../../../shared/url";
import { getAllowedHosts, isUrlAllowed } from "../../../shared/urlSafety";

// Worker消息类型定义
type UploadWorkerMessage =
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
       * File 结构化克隆进 Worker，分片按需 slice 读取，内存驻留与文件大小无关。
       */
      fileRef: File;
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
      /** 暂停指定文件的上传任务（T3.3）：分片边界安全暂停，Worker 挂起等待 resume */
      type: "pause";
      fileId: string;
    }
  | {
      /** 继续指定文件的上传任务（T3.3）：解除 Worker 挂起，从断点续传 */
      type: "resume";
      fileId: string;
    };

// 每个上传任务的 AbortController（按 fileId 索引），收到 CANCEL 时中断在途请求
const taskAbortControllers = new Map<string, AbortController>();
// 每个上传任务允许携带鉴权头的宿主白名单（F3，SSRF/token 泄漏防护），
// 由 baseURL 推导，随任务开始解析、结束清理。
const taskAllowedHosts = new Map<string, string[]>();
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

// 调试日志函数
let DEBUG_ENABLED = false;
const DEBUG_THROTTLE_MS = 200;
let lastRoutineDebugAt = 0;

/**
 * @param urgent 紧急日志（失败/重试/超时/取消）不受节流限制；
 *               分片级等高频常规日志按 200ms 节流。
 */
function debug(
  message: string,
  data?: Record<string, unknown>,
  urgent = false,
): void {
  if (!DEBUG_ENABLED) {
    return;
  }

  const now = Date.now();
  if (!urgent && now - lastRoutineDebugAt < DEBUG_THROTTLE_MS) {
    return;
  }
  if (!urgent) {
    lastRoutineDebugAt = now;
  }

  debugLog(`[UploadWorker] ${message}`, data || "");
  // 同时发送日志消息到主线程
  self.postMessage({
    type: "debug",
    message,
    data,
  });
}

// 使用 spark-md5 计算文件哈希
function calculateMD5(buffer: ArrayBuffer): string {
  debug("开始计算MD5");
  const spark = new SparkMD5.ArrayBuffer();
  spark.append(buffer);
  const result = spark.end();
  debug("MD5计算完成", { result });
  return result;
}

// 使用自定义重试逻辑进行带重试的请求
async function fetchWithRetry(
  url: string,
  options: RequestInit,
  {
    maxRetries = 3,
    timeout = 30000,
    retryInterval = 1000,
    authHeaders,
    credentials,
    /** F3：允许携带鉴权头的宿主白名单；URL host 不在白名单内时不附加 authHeaders */
    allowedHosts,
    signal,
  }: {
    maxRetries?: number;
    timeout?: number;
    retryInterval?: number;
    authHeaders?: Record<string, string>;
    credentials?: RequestCredentials;
    /** F3：允许携带鉴权头的宿主白名单；URL host 不在白名单内时不附加 authHeaders */
    allowedHosts?: string[];
    /** 外部取消信号（任务级 AbortController）：abort 时中断在途 fetch 与重试 */
    signal?: AbortSignal;
  } = {},
): Promise<Response> {
  // 默认 same-origin：跨域 Bearer 头鉴权时不携带 Cookie，也不会触发 preflight
  // 对 Access-Control-Allow-Credentials:true 的强校验；仅当显式传入 'include' 时才携带 Cookie。
  const requestCredentials: RequestCredentials = credentials ?? "same-origin";
  debug(`开始请求: ${url}`, { method: options.method, maxRetries });

  // 合并鉴权头（authHeaders 优先级低于调用方显式 headers，避免覆盖 Content-Type 等）
  // F3：仅当目标 URL 的 host 命中白名单时才附加 authHeaders；非白名单域名
  // （如错误的 baseURL / 外部 URL）一律不携带 Bearer，避免 token 泄漏到任意站点。
  const sendAuth = isUrlAllowed(url, allowedHosts ?? []);
  const mergedHeaders: Record<string, string> = {
    ...(sendAuth ? (authHeaders ?? {}) : {}),
    ...(options.headers as Record<string, string> | undefined),
  };

  return new Promise<Response>((resolve, reject) => {
    // 自定义重试逻辑，不使用async库
    let attempts = 0;

    const makeRequest = async () => {
      // 取消后不再发起（或重试）任何请求
      if (signal?.aborted) {
        const error = new Error("上传已取消");
        error.name = "AbortError";
        reject(error);
        return;
      }

      // 如果超过最大重试次数，则拒绝
      if (attempts >= maxRetries) {
        const error = new Error(`已达到最大重试次数: ${maxRetries}`);
        debug(
          `请求最终失败: ${url}`,
          { error: error.message, maxRetries },
          true,
        );
        self.postMessage({
          type: "retry",
          error: error.message,
          attemptNumber: maxRetries,
          retriesLeft: 0,
          message: `已达到最大重试次数(${maxRetries}次)，上传失败`,
        });
        reject(error);
        return;
      }

      attempts++;
      const currentAttempt = attempts;

      // 超时定时器句柄提升到 try 外：确保 5xx 重试 / 网络异常分支
      // 也能在 finally 中收敛，避免定时器残留
      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      try {
        // 创建 AbortController 用于超时控制
        const controller = new AbortController();
        // 外部取消信号联动：CANCEL 到达时一并中断在途 fetch
        if (signal) {
          if (signal.aborted) {
            controller.abort();
          } else {
            signal.addEventListener("abort", () => controller.abort(), {
              once: true,
            });
          }
        }
        timeoutId = setTimeout(() => {
          debug(`请求超时: ${url}`, { timeout, attempt: currentAttempt }, true);
          controller.abort();
        }, timeout);

        debug(`执行请求: ${url} (尝试 ${currentAttempt}/${maxRetries})`, {
          method: options.method,
          headers: mergedHeaders ? JSON.stringify(mergedHeaders) : undefined,
          bodyType: options.body ? typeof options.body : undefined,
        });

        const response = await fetch(url, {
          ...options,
          headers: mergedHeaders,
          // credentials 策略：默认 same-origin（跨域不送 Cookie，Authorization 头照常发送）；
          // 仅当 uploadConfig.withCredentials 为 true（同域/跨域 Cookie 鉴权）时才 'include'，
          // 此时需服务端返回 Access-Control-Allow-Credentials:true。
          credentials: requestCredentials,
          signal: controller.signal,
        });

        clearTimeout(timeoutId);
        debug(`请求完成: ${url} (尝试 ${currentAttempt}/${maxRetries})`, {
          status: response.status,
          statusText: response.statusText,
        });

        if (!response.ok) {
          let errorText = "";
          let apiMessage: string | undefined;
          try {
            errorText = await response.text();
            if (errorText) {
              try {
                const parsed = JSON.parse(errorText) as { message?: unknown };
                if (typeof parsed.message === "string" && parsed.message) {
                  apiMessage = parsed.message;
                }
              } catch {
                // 非 JSON 错误响应时保留原始文本到日志即可
              }
            }
          } catch {
            debug("无法读取错误响应内容");
          }

          const error = new Error(
            apiMessage
              ? `HTTP 错误 ${response.status}: ${apiMessage}`
              : `HTTP 错误 ${response.status}: ${response.statusText}`,
          );
          debug(
            `请求失败: ${url} (尝试 ${currentAttempt}/${maxRetries})`,
            {
              status: response.status,
              statusText: response.statusText,
              errorText: errorText.substring(0, 200),
              apiMessage,
            },
            true,
          );

          // 判断是否需要重试
          const isServerError = response.status >= 500;
          if (isServerError && attempts < maxRetries) {
            const nextRetryDelay = retryInterval * currentAttempt;
            debug(`将在 ${nextRetryDelay}ms 后重试请求`, undefined, true);
            setTimeout(makeRequest, nextRetryDelay);
            return;
          }

          reject(error);
          return;
        }

        // 请求成功
        debug(`请求成功: ${url} (尝试 ${currentAttempt}/${maxRetries})`);
        resolve(response);
      } catch (error) {
        const wrappedError =
          error instanceof Error ? error : new Error(String(error));
        debug(
          `请求异常: ${url} (尝试 ${currentAttempt}/${maxRetries})`,
          {
            error: wrappedError.message,
          },
          true,
        );

        // 判断是否需要重试
        const isNetworkError =
          wrappedError.name === "TypeError" ||
          wrappedError.message.includes("network");
        const isTimeoutError =
          wrappedError.name === "AbortError" ||
          wrappedError.message.includes("timeout");

        if ((isNetworkError || isTimeoutError) && attempts < maxRetries) {
          const nextRetryDelay = retryInterval * currentAttempt;
          debug(`将在 ${nextRetryDelay}ms 后重试请求`, undefined, true);
          setTimeout(makeRequest, nextRetryDelay);
          return;
        }

        reject(wrappedError);
      } finally {
        // 收敛定时器：无论成功、5xx 重试还是网络异常，都不残留未清理的 timeout
        if (timeoutId !== undefined) {
          clearTimeout(timeoutId);
        }
      }
    };

    // 开始第一次请求
    makeRequest();
  });
}

self.onmessage = async (event: MessageEvent<UploadWorkerMessage>) => {
  let fileId: string | undefined;
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

    const { fileInfo, fileRef, networkParams, uploadConfig } = event.data;
    fileId = fileInfo.id;
    const authHeaders = uploadConfig?.authHeaders;
    // F3：由 baseURL 推导允许携带鉴权头的宿主白名单（SSRF/token 泄漏防护）
    taskAllowedHosts.set(
      fileInfo.id,
      getAllowedHosts({ baseURL: uploadConfig?.baseURL })
    );
    // 调试日志开关由每次上传任务的配置注入（默认关闭）
    DEBUG_ENABLED = uploadConfig?.debug === true;
    // 仅当显式开启 withCredentials（Cookie 鉴权）时才带 'include'，否则 same-origin
    const credentialsMode: RequestCredentials =
      uploadConfig?.withCredentials === true ? "include" : "same-origin";

    // 检查必要参数
    if (!fileInfo) {
      debug("缺少文件信息", event.data as unknown as Record<string, unknown>);
      throw new Error("缺少必要参数：fileInfo");
    }

    if (!fileRef) {
      debug("缺少文件引用", {
        fileId: fileInfo?.id,
        fileName: fileInfo?.fileName,
      });
      throw new Error("缺少必要参数：fileRef");
    }

    // 任务级取消信号：CANCEL 消息或主线程 terminate 均可中断全部在途请求（P1-8）
    const taskController = new AbortController();
    taskAbortControllers.set(fileInfo.id, taskController);
    // 初始化暂停状态与续传统计（T3.3）
    taskPauseState.set(fileInfo.id, { paused: false, resumeResolver: null });
    const taskSignal = taskController.signal;

    debug("文件信息", {
      fileName: fileInfo.fileName,
      fileSize: fileInfo.fileSize,
      hash: fileInfo.hash,
    });

    const chunkSize = fileInfo.chunkSize || 1024 * 1024;
    const chunkCount = Math.ceil(fileRef.size / chunkSize);
    taskStats.set(fileInfo.id, { uploadedChunks: 0, totalChunks: chunkCount });
    debug("分片信息", {
      chunkSize,
      chunkCount,
      totalSize: fileRef.size,
    });

    // 使用网络参数中的分片并发数和重试参数
    const chunkConcurrency = networkParams?.chunkConcurrency || 2;
    const retryOptions = {
      maxRetries: networkParams?.maxRetries || 3,
      timeout: networkParams?.timeout || 30000,
      retryInterval: networkParams?.retryInterval || 1000,
    };
    debug("网络参数", { chunkConcurrency, ...retryOptions });

    const baseURL = uploadConfig?.baseURL || "";
    const checkApi = uploadConfig?.checkApi || "/api/file/instant";
    const apiUrl = joinUrl(baseURL, checkApi);
    // P2-1：续传信息改由 /status 获取。沿用 checkApi 的命名约定推导：
    //   /api/file/instant → /api/file/status。
    // 自定义 checkApi 且未提供同名 /status 时，状态查询失败会退化为「全部重传」，
    // 只损失续传优化，不影响正确性。
    const statusApi = /\/instant\/?$/.test(checkApi)
      ? checkApi.replace(/\/instant\/?$/, "/status")
      : "/api/file/status";
    const statusUrl = joinUrl(baseURL, statusApi);

    // P2-1（a）：秒传快路径前置。
    // 旧实现必须先串行算完全部分片 MD5（大文件数千片、数分钟）才发秒传确认，
    // 即便文件早已存在也要白付一轮全量哈希。这里先不带 chunk_md5s 做一次轻量确认：
    // 命中即结束，分片哈希一个都不算。
    let fastData: {
      data?: { uploaded?: boolean; reset?: boolean };
    } | null = null;
    try {
      debug("开始秒传预检（不含分片 MD5）");
      const fastRes = await fetchWithRetry(
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
        {
          ...retryOptions,
          authHeaders,
          credentials: credentialsMode,
          allowedHosts: taskAllowedHosts.get(fileInfo.id),
          signal: taskSignal,
        },
      ).catch((error: unknown) => {
        // 预检失败不改变主流程：后续状态查询会退化为全量重传，
        // 真正的鉴权 / 网络错误会在分片上传阶段照常抛出。
        debug("秒传预检请求失败，继续常规流程", { error: String(error) }, true);
        return null;
      });

      fastData = fastRes ? await fastRes.json().catch(() => null) : null;
      if (fastData?.data?.uploaded) {
        debug("文件已秒传（预检命中，跳过全部分片 MD5）", {
          fileName: fileInfo.fileName,
        });
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
    if (fastData) {
      try {
        const statusQuery = `file_id=${encodeURIComponent(
          fileInfo.chunkKey || fileInfo.hash || "",
        )}&md5=${encodeURIComponent(fileInfo.hash || "")}`;
        const statusRes = await fetchWithRetry(
          `${statusUrl}?${statusQuery}`,
          { method: "GET" },
          {
            ...retryOptions,
            authHeaders,
            credentials: credentialsMode,
            allowedHosts: taskAllowedHosts.get(fileInfo.id),
            signal: taskSignal,
          },
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
        // 状态查询失败不应阻塞上传：退化为全量重传即可。
        debug("状态查询失败，按全量重传处理", { error: String(error) }, true);
      }
    }

    // 确定需要上传的分片
    const needUploadChunks: number[] = [];
    for (let i = 0; i < chunkCount; i++) {
      if (!existingChunks.has(i)) needUploadChunks.push(i);
    }
    debug("需要上传的分片", {
      count: needUploadChunks.length,
      chunks: needUploadChunks,
    });

    try {
      // 记录已完成的分片数量，用于计算进度
      const completedChunks = chunkCount - needUploadChunks.length;
      let totalUploadedChunks = completedChunks;
      const failedChunks: number[] = [];

      // 3. 分片上传 - 使用并发控制
      if (needUploadChunks.length > 0) {
        debug("开始分片上传");
        // 上传阶段计时起点，用于推导速率/剩余时间（T3.4）
        const uploadStartTime = Date.now();
        const uploadTasks = needUploadChunks.map((i) => {
          return async () => {
            // 分片边界安全暂停（T3.3）：开始下一个分片前检查，暂停则挂起等待 resume
            await waitWhilePaused(fileInfo.id, taskSignal);
            if (taskSignal.aborted) {
              throw new Error("上传已取消");
            }

            const start = i * chunkSize;
            const end = Math.min(fileRef.size, start + chunkSize);
            const chunkBuf = await fileRef.slice(start, end).arrayBuffer();
            // P2-1：按需计算——只算当前要上传的分片，不再预计算全部分片
            const chunkMd5 = await calculateMD5(chunkBuf);

            const formData = new FormData();
            formData.append(
              "file_id",
              fileInfo.chunkKey || fileInfo.hash || "",
            );
            formData.append("index", i.toString());
            formData.append("chunk", new Blob([chunkBuf]));
            formData.append("total", chunkCount.toString());
            formData.append("chunk_md5", chunkMd5);

            debug(`上传分片 ${i + 1}/${chunkCount}`, { size: end - start });
            try {
              // 使用配置的上传 API 地址
              const uploadApi = uploadConfig?.uploadApi || "/api/file/upload";
              const uploadUrl = joinUrl(baseURL, uploadApi);
              debug(`分片上传URL: ${uploadUrl}`);

              await fetchWithRetry(
                uploadUrl,
                {
                  method: "POST",
                  body: formData,
                },
                {
                  ...retryOptions,
                  authHeaders,
                  credentials: credentialsMode,
                  allowedHosts: taskAllowedHosts.get(fileInfo.id),
                  signal: taskSignal,
                },
              );

              // 更新进度
              totalUploadedChunks++;
              const stats = taskStats.get(fileInfo.id);
              if (stats) {
                stats.uploadedChunks = totalUploadedChunks;
              }
              const uploadedBytes = Math.min(
                totalUploadedChunks * chunkSize,
                fileRef.size,
              );
              const elapsedMs = Math.max(1, Date.now() - uploadStartTime);
              const detail = computeUploadProgress({
                uploadedBytes,
                totalBytes: fileRef.size,
                elapsedMs,
              });
              debug(`分片 ${i + 1} 上传成功，总进度: ${detail.progress}%`);

              self.postMessage({
                type: "progress",
                progress: detail.progress,
                uploadedBytes: detail.uploadedBytes,
                totalBytes: detail.totalBytes,
                speed: detail.speed,
                eta: detail.eta,
                chunkIndex: i,
              });
            } catch (error) {
              // 记录失败的分片
              failedChunks.push(i);
              debug(
                `分片 ${i + 1} 上传失败`,
                {
                  error: error instanceof Error ? error.message : String(error),
                },
                true,
              );
              debugError(`分片 ${i + 1} 上传失败:`, error);
              throw error;
            }
          };
        });

        // 使用并发控制函数执行上传任务
        debug("执行并发上传任务", {
          tasks: uploadTasks.length,
          concurrency: chunkConcurrency,
        });
        await runWithConcurrency(uploadTasks, chunkConcurrency);
        debug("并发上传任务完成", { failedChunks: failedChunks.length });

        // 暂停边界：若暂停到达时所有在途分片已结束（极端时序），在此确认 paused，
        // 并结束本次上传任务（Worker 回到空闲，等待主线程 resume 重新发起或取消）
        if (taskPauseState.get(fileInfo.id)?.paused) {
          const stats = taskStats.get(fileInfo.id);
          self.postMessage({
            type: "paused",
            fileId: fileInfo.id,
            uploadedChunks: stats?.uploadedChunks ?? totalUploadedChunks,
            totalChunks: stats?.totalChunks ?? chunkCount,
          });
          return;
        }

        // 如果有失败的分片，报告错误
        if (failedChunks.length > 0) {
          debug(
            "有分片上传失败",
            {
              count: failedChunks.length,
              chunks: failedChunks,
            },
            true,
          );
          self.postMessage({
            type: "error",
            message: `有 ${failedChunks.length} 个分片上传失败，请重试上传`,
            failedChunks: failedChunks,
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
        hash_mode: uploadConfig.hashMode,
      };
      debug("合并请求体", mergeRequestBody);

      const mergeUrl = joinUrl(
        baseURL,
        uploadConfig?.mergeApi || "/api/file/merge",
      );
      debug(`合并文件URL: ${mergeUrl}`);

      await fetchWithRetry(
        mergeUrl,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(mergeRequestBody),
        },
        {
          ...retryOptions,
          authHeaders,
          credentials: credentialsMode,
          allowedHosts: taskAllowedHosts.get(fileInfo.id),
          signal: taskSignal,
        },
      );
      debug("文件合并成功");

      self.postMessage({ type: "done", skipped: false });
    } catch (error) {
      // 上传过程中出现致命错误
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      debug("上传过程中出现致命错误", { error: errorMessage }, true);
      self.postMessage({
        type: "error",
        message: errorMessage,
      });
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
    // Worker 执行过程中的全局错误处理
    const errorMessage = error instanceof Error ? error.message : String(error);
    debug("Worker 执行错误", { error: errorMessage }, true);
    self.postMessage({
      type: "error",
      message: errorMessage,
    });
  }
};

// 简单的并发控制函数
async function runWithConcurrency(
  tasks: (() => Promise<void>)[],
  concurrency: number,
): Promise<{ completed: number; failed: number; failedIndices: number[] }> {
  // 当前运行的任务数
  let running = 0;
  // 下一个要执行的任务索引
  let taskIndex = 0;
  // 成功和失败的任务计数
  let completed = 0;
  let failed = 0;
  // 失败的任务索引
  const failedIndices: number[] = [];

  debug("开始并发控制", { tasks: tasks.length, concurrency });

  return new Promise((resolve) => {
    // 启动初始任务
    const startNext = () => {
      // 如果所有任务都完成了，解析 Promise
      if (taskIndex >= tasks.length && running === 0) {
        debug("并发任务全部完成", { completed, failed });
        resolve({ completed, failed, failedIndices });
        return;
      }

      // 当有空闲并且还有任务时，启动新任务
      while (running < concurrency && taskIndex < tasks.length) {
        const currentIndex = taskIndex;
        const currentTask = tasks[taskIndex++];
        if (!currentTask) {
          continue;
        }
        running++;
        debug(
          `启动任务 ${currentIndex + 1}/${tasks.length}，当前运行: ${running}`,
        );

        currentTask()
          .then(() => {
            completed++;
            running--;
            debug(
              `任务 ${
                currentIndex + 1
              } 完成，剩余运行: ${running}，完成: ${completed}，失败: ${failed}`,
            );
            startNext(); // 任务完成后，尝试启动下一个任务
          })
          .catch(() => {
            failed++;
            failedIndices.push(currentIndex);
            running--;
            debug(
              `任务 ${
                currentIndex + 1
              } 失败，剩余运行: ${running}，完成: ${completed}，失败: ${failed}`,
            );
            startNext(); // 即使失败也尝试启动下一个任务
          });
      }
    };

    startNext();
  });
}
