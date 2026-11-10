/**
 * 主线程 File 引用注册表：保存同一会话内可复用的 File 句柄。
 *
 * 上传由 Worker 按分片 `fileRef.slice(start, end)` 惰性读取，内存占用与文件大小解耦；
 * 元数据存 localforage，未确认成功的分片字节存 chunkCacheStore 的独立 IDB 库。
 * 注册表只管「本次会话」；刷新后必然清空，续传改由分片缓存提供字节。
 *
 * 生命周期：预处理完成后 register；上传终态、删除、清理时 release，
 * 避免 File 句柄长期驻留导致底层数据无法 GC。缓存缺失或超过上限时，
 * 文件标记 awaitingReselect，由用户重新选择同一文件绑定。
 *
 * 由 `createFileRegistry()` 工厂按实例创建，多个 <FileUpload> 互不串数据。
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
