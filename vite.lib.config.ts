import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react-swc";

const projectRoot = fileURLToPath(new URL(".", import.meta.url));

/**
 * VU-25 / VU-24 的取舍：
 * - 应用（demo）构建保留 `?worker`，产出独立 worker asset，主包更小、可缓存。
 * - 库构建把 `?worker` 重写为 `?worker&inline`，让分发产物自包含；
 *   否则 `import.meta.ROLLDOWN_FILE_URL_*` 指向的资产路径在消费方 dev server
 *   下会被 SPA fallback 吞掉（历史注释记录的「文件预处理失败」根因）。
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
    // VU-62/CI：不自动清空输出目录，避免触发 WorkBuddy 批量删除安全守卫
    // （重复构建会 rmSync 整个 dist/lib 触发 SAFE_DELETE_BULK_CONFIRM_REQUIRED）。
    // 依赖 clean checkout（CI）或本地 `rm -rf dist` 后重建以获得干净产物。
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
