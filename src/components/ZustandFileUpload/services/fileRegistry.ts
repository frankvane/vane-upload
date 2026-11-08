/**
 * 主线程 File 引用注册表（T3.1 流式分片 / T3.2 单例治理）。
 *
 * 背景：T3.1 起 IndexedDB 的「元数据」库不再整文件驻留文件内容
 * （原 UploadFile.buffer 已移除）。上传时由 uploadWorker 按分片
 * `fileRef.slice(start, end)` 惰性读取，内存占用与文件大小解耦。
 *
 * 与分片缓存（方案 A）的分工：
 * - 元数据库只存上传元数据；
 * - 未确认成功的分片字节由 chunkCacheStore 写入独立的
 *   `react-upload-chunks` 库，用于刷新后零点击续传；
 * - 本注册表只解决「同一次会话内」的 File 句柄复用，刷新后必然清空。
 *
 * 生命周期：
 * - register：文件预处理完成（useFileProcessor）时登记；
 * - release ：上传成功/失败终态、删除、清理时释放（避免 File 句柄长期
 *             驻留导致底层数据无法 GC）；
 * - 页面刷新后注册表清空，字节来源切换到分片缓存：缓存就绪则自动续传，
 *   缓存缺失/超上限时才标记 awaitingReselect，由用户重新选择同一文件绑定。
 *
 * T3.2 治理：不再是模块级单例，改为由 `createFileRegistry()` 工厂创建，
 * 每个 <FileUpload> 实例持有各自独立的注册表，互不串数据。
 */
export interface FileRegistry {
  /** 登记文件引用（同 id 重复登记以最新为准） */
  registerFileRef: (id: string, file: File) => void;
  /** 取文件引用；不存在返回 undefined（典型场景：页面刷新后，此时由分片缓存接管字节来源） */
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
