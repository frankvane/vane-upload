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
import type { BatchInfo } from "../types/upload";
import { withClearedCountdown } from "./uploadPolicy";

export interface UploaderLifecycleParams {
  engine: UploadEngine;
  refreshFiles: () => Promise<void> | void;
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
  flushRefresh: () => Promise<void>;
  scheduleRefresh: (delay?: number) => void;
}

const createCleanupPolicy = (engine: UploadEngine) =>
  new UploadCleanupPolicy({
    getFiles: () => engine.store.getState().files,
    setFiles: (files) => engine.store.getState().setFiles(files),
    refreshFiles: () => engine.store.getState().refreshFiles(),
    setBatchInfo: (updater) => engine.store.getState().setBatchInfo(updater),
    clearBatchInfo: () => engine.store.getState().setBatchInfo(null),
    getCleanupDelay: () => engine.store.getState().cleanupDelay,
    storage: engine.storage,
    fileRegistry: engine.fileRegistry,
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
  const refreshTimerRef = useRef<number | null>(null);
  const isRefreshingRef = useRef(false);
  const queuedRefreshRef = useRef(false);

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

  const scheduleRefresh = useCallback(
    (delay = 120) => {
      if (refreshTimerRef.current !== null) {
        return;
      }

      refreshTimerRef.current = window.setTimeout(() => {
        refreshTimerRef.current = null;
        void flushRefresh().catch(() => undefined);
      }, delay);
    },
    [flushRefresh]
  );

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

      if (refreshTimerRef.current !== null) {
        clearTimeout(refreshTimerRef.current);
        refreshTimerRef.current = null;
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

  return {
    cleanupPolicy,
    activeUploadAbortRef,
    beginBatchSession,
    endBatchSession,
    flushRefresh,
    scheduleRefresh,
  };
}
