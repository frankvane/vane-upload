import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react-swc";

const projectRoot = fileURLToPath(new URL(".", import.meta.url));

/**
 * 库构建把 `?worker` 重写为 `?worker&inline`，让分发产物自包含；
 * demo 构建保留独立 worker asset，主包更小、可缓存。
 * 不内联的话，`import.meta.ROLLDOWN_FILE_URL_*` 指向的资产路径在消费方
 * dev server 下会被 SPA fallback 吞掉，表现为文件预处理失败。
 */
function inlineWorkersForLibrary(): Plugin {
  return {
    name: "vane-upload:inline-workers-for-library",
    enforce: "pre",
    resolveId(source, importer) {
      if (!importer || !/\.tsx?\?worker$/.test(source)) {
        return null;
      }
      const specifier = source.slice(0, source.indexOf("?"));
      const absolute = resolve(dirname(importer), specifier).replace(/\\/g, "/");
      return `${absolute}?worker&inline`;
    },
  };
}

/** React / 状态库 / 运行时依赖不进库产物，由消费方提供，避免重复打包。 */
const EXTERNAL_RE = /^(react|react-dom|zustand|localforage|spark-md5)(\/|$)/;

export default defineConfig({
  plugins: [react(), inlineWorkersForLibrary()],
  build: {
    outDir: "dist/lib",
    // T-11（VU-65）：仍关闭空目录，但不再是「放任堆积」——由
    // `scripts/prune-stale-assets.mjs` 在构建后按时间戳定点清理上一代 hashed chunk。
    // 不能开 emptyOutDir 的原因已实测：`dist/lib` 里有 tsc 产出的 .d.ts 目录树，
    // 递归 rmSync 会超过平台批量删除守卫阈值（50 个文件），使 `npm run ci`
    // 直接中断在 prepare-out-dir（实测报 SAFE_DELETE_BULK_CONFIRM_REQUIRED）。
    emptyOutDir: false,
    lib: {
      entry: resolve(projectRoot, "src/index.ts"),
      name: "VaneUpload",
      formats: ["es", "cjs"],
      fileName: (format) => (format === "es" ? "index.js" : "index.cjs"),
      cssFileName: "style",
    },
    rollupOptions: {
      external: (id: string) => EXTERNAL_RE.test(id),
      // 公共入口同时有 default 与具名导出；CJS 下显式声明 named，
      // 避免 Rollup 的 MIXED_EXPORTS 警告，语义不变（default 走 `.default`）。
      output: {
        exports: "named",
      },
    },
  },
});
