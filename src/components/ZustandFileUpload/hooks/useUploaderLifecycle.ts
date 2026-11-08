/**
 * 上传生命周期（编排基础设施）：abort 会话、刷新调度、自动清理与卸载销毁。
 *
 * 本 hook 只负责「副作用生命周期」——worker/引擎句柄的会话管理、刷新节流、
 * 自动清理定时器与卸载清理。它不实现任何业务状态机逻辑（那些在
 * uploadPolicy.ts 与 useBatchUploaderController.ts 中）。
 *
 * 关键不变量：effect 注册顺序与原来内联在 useBatchUploader 时一致
 * （卸载清理 effect 在前，autoCleanup effect 在后），以保证行为等价。
 */

import { useCallback, useEffect, useMemo, useRef } from "react";

import { UploadCleanupPolicy } from "../services/cleanupPolicy";
import type { UploadEngine } from "../context/UploadEngineContext";
import type { BatchInfo, UploadFile } from "../types/upload";
import { withClearedCountdown } from "./uploadPolicy";

export interface UploaderLifecycleParams {
  engine: UploadEngine;
  refreshFiles: () => Promise<void>;
  setBatchInfo: (
    updater: (prev: BatchInfo | null) => BatchInfo | null
  ) => void;
  autoCleanup: boolean;
}

export interface UploaderLifecycle {
  cleanupPolicy: UploadCleanupPolicy;
  activeUploadAbortRef: React.MutableRefObject<AbortController | null>;
  beginBatchSession: () => AbortController;
  endBatchSession: (controller: AbortController) => void;
  /**
   * VU-18：把已知的最新文件态即时同步进 store（纯内存，不读 IndexedDB）。
   * 上传期的状态转换用它取代原先 120ms 后触发的全量 iterate + 排序。
   */
  syncFile: (file: UploadFile) => void;
  /** 批次结束 / 显式请求时的全量对账读（整个批次最多一次）。 */
  flushRefresh: () => Promise<void>;
}

const createCleanupPolicy = (engine: UploadEngine) =>
  new UploadCleanupPolicy({
    getFiles: () => engine.store.getState().files,
    setFiles: (files) => engine.store.getState().setFiles(files),
    refreshFiles: (knownFiles) =>
      engine.store.getState().refreshFiles(knownFiles),
    setBatchInfo: (updater) => engine.store.getState().setBatchInfo(updater),
    clearBatchInfo: () => engine.store.getState().setBatchInfo(null),
    getCleanupDelay: () => engine.store.getState().cleanupDelay,
    storage: engine.storage,
    fileRegistry: engine.fileRegistry,
    instanceId: engine.instanceId,
  });

export function useUploaderLifecycle({
  engine,
  refreshFiles,
  setBatchInfo,
  autoCleanup,
}: UploaderLifecycleParams): UploaderLifecycle {
  const cleanupPolicy = useMemo(() => createCleanupPolicy(engine), [engine]);
  const activeUploadAbortRef = useRef<AbortController | null>(null);
  const bootstrapAutoCleanupTimerRef = useRef<number | null>(null);
  // VU-18：不再有 refreshTimerRef —— 上传期状态转换不再排队一次定时全量读。
  const isRefreshingRef = useRef(false);
  const queuedRefreshRef = useRef(false);

  const syncFile = useCallback(
    (file: UploadFile) => {
      const state = engine.store.getState();
      const known = state.files.some((item) => item.id === file.id);
      if (known) {
        // 已在列表内：局部替换，列表引用变化一次，进度相关的订阅不受影响。
        state.patchFile(file.id, { ...file });
        return;
      }
      // 列表里还没有这条记录（并发新增 / 外部写入）：退回一次全量对账，
      // 保证不会把新文件丢在 UI 之外。
      void refreshFiles().catch(() => undefined);
    },
    [engine, refreshFiles]
  );

  const flushRefresh = useCallback(async () => {
    if (isRefreshingRef.current) {
      queuedRefreshRef.current = true;
      return;
    }

    isRefreshingRef.current = true;
    try {
      await refreshFiles();
    } finally {
      isRefreshingRef.current = false;
      if (queuedRefreshRef.current) {
        queuedRefreshRef.current = false;
        void flushRefresh().catch(() => undefined);
      }
    }
  }, [refreshFiles]);

  const beginBatchSession = useCallback(() => {
    const existingController = activeUploadAbortRef.current;
    if (existingController && !existingController.signal.aborted) {
      existingController.abort();
    }

    const controller = new AbortController();
    activeUploadAbortRef.current = controller;
    return controller;
  }, []);

  const endBatchSession = useCallback((controller: AbortController) => {
    if (activeUploadAbortRef.current === controller) {
      activeUploadAbortRef.current = null;
    }
  }, []);

  // 卸载清理：中止在途会话、清理定时器、销毁清理策略。
  useEffect(() => {
    return () => {
      const activeController = activeUploadAbortRef.current;
      if (activeController && !activeController.signal.aborted) {
        activeController.abort();
      }
      activeUploadAbortRef.current = null;

      if (bootstrapAutoCleanupTimerRef.current !== null) {
        clearTimeout(bootstrapAutoCleanupTimerRef.current);
        bootstrapAutoCleanupTimerRef.current = null;
      }

      queuedRefreshRef.current = false;
      cleanupPolicy.dispose();
    };
  }, [cleanupPolicy]);

  // 自动清理引导：autoCleanup 关闭时立即清理并清除倒计时；开启时延迟触发。
  useEffect(() => {
    if (!autoCleanup) {
      if (bootstrapAutoCleanupTimerRef.current !== null) {
        clearTimeout(bootstrapAutoCleanupTimerRef.current);
        bootstrapAutoCleanupTimerRef.current = null;
      }
      cleanupPolicy.dispose();
      setBatchInfo((prev) => withClearedCountdown(prev));
      return;
    }

    if (bootstrapAutoCleanupTimerRef.current !== null) {
      return;
    }

    bootstrapAutoCleanupTimerRef.current = window.setTimeout(() => {
      bootstrapAutoCleanupTimerRef.current = null;
      void cleanupPolicy.cleanupUploadedFiles();
    }, 2000);
  }, [autoCleanup, cleanupPolicy, setBatchInfo]);

  // VU-42：返回对象保持身份稳定，避免下游 useCallback / memo 被每次渲染
  // 新建的包装对象击穿。内部成员本身已全部 useMemo / useCallback / useRef 化。
  return useMemo(
    () => ({
      cleanupPolicy,
      activeUploadAbortRef,
      beginBatchSession,
      endBatchSession,
      syncFile,
      flushRefresh,
    }),
    [
      cleanupPolicy,
      beginBatchSession,
      endBatchSession,
      syncFile,
      flushRefresh,
    ]
  );
}
