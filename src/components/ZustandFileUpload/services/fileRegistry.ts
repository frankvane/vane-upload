/**
 * 主线程 File 引用注册表（T3.1 流式分片 / T3.2 单例治理）。
 *
 * 背景：T3.1 起 IndexedDB 只持久化上传元数据，文件字节不再整文件驻留
 * （原 UploadFile.buffer 已移除）。上传时由 uploadWorker 按分片
 * `fileRef.slice(start, end)` 惰性读取，内存占用与文件大小解耦。
 *
 * 生命周期：
 * - register：文件预处理完成（useFileProcessor）时登记；
 * - release ：上传成功/失败终态、删除、清理时释放（避免 File 句柄长期
 *             驻留导致底层数据无法 GC）；
 * - 页面刷新后注册表清空 → 记录标记 awaitingReselect，用户重新选择
 *   同一文件时以相同队列 id 再次登记。
 *
 * T3.2 治理：不再是模块级单例，改为由 `createFileRegistry()` 工厂创建，
 * 每个 <FileUpload> 实例持有各自独立的注册表，互不串数据。
 */
export interface FileRegistry {
  /** 登记文件引用（同 id 重复登记以最新为准） */
  registerFileRef: (id: string, file: File) => void;
  /** 取文件引用；不存在返回 undefined（典型场景：页面刷新后未重新选择） */
  getFileRef: (id: string) => File | undefined;
  /** 释放单个文件引用 */
  releaseFileRef: (id: string) => void;
  /** 清空全部引用（仅测试/调试用；业务释放走 releaseFileRef） */
  releaseAllFileRefs: () => void;
  /** 当前登记数量（测试与调试用） */
  fileRefCount: () => number;
}

export const createFileRegistry = (): FileRegistry => {
  const registry = new Map<string, File>();

  return {
    registerFileRef: (id, file) => {
      registry.set(id, file);
    },
    getFileRef: (id) => registry.get(id),
    releaseFileRef: (id) => {
      registry.delete(id);
    },
    releaseAllFileRefs: () => {
      registry.clear();
    },
    fileRefCount: () => registry.size,
  };
};
