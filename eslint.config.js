import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";

// 后端（server 工作区）为 CommonJS + 纯 Node 运行环境，沿用 Node 全局表。
// 但 Node 20+ 已将 File / crypto 提升为内置全局，server 又通过 require 重新引入同名符号，
// 会触发 no-redeclare。这里从 lint 全局表中移除二者，让 require 引入的本地声明合法，
// 同时保留规则对「同作用域内真实重复声明」的捕获能力。
const serverNodeGlobals = (() => {
  const g = { ...globals.node };
  delete g.File;
  delete g.crypto;
  return g;
})();

export default tseslint.config(
  {
    ignores: [
      "dist/**",
      "coverage/**",
      "node_modules/**",
      "**/*.tsbuildinfo",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.{ts,tsx}"],
    languageOptions: {
      globals: {
        ...globals.browser,
        self: "readonly",
      },
    },
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      // VU-20：重新启用 react-hooks v7 全套规则（v7.1.1 的 recommended）。
      // 此前仅开了经典的 rules-of-hooks / exhaustive-deps，其余 v7 新规则长期处于关闭态。
      ...reactHooks.configs.recommended.rules,
      // VU-64：UI 库需导出非组件常量（Typography 对象、confirm 函数、UploadContext），
      // 允许常量导出，从而删掉各处的 react-refresh/only-export-components 行内禁用。
      //
      // VU-65（T-03）：allowConstantExport 只放行字面量常量，覆盖不到以下三个符号——
      // 它们分别是「上下文对象 + Provider 同文件」「命令式 API + 组件同文件」
      // 「组件聚合对象」，都是本库有意的对外形态，且行内禁用会随重构失效（曾留下 5 条
      // 失效禁用）。改为在配置里**逐名**放行：新出现的非组件导出仍会告警，
      // 不会因整目录关规则而失守。
      "react-refresh/only-export-components": [
        "warn",
        {
          allowConstantExport: true,
          allowExportNames: ["UploadContext", "Typography", "confirm"],
        },
      ],
    },
  },
  {
    files: ["src/**/*.test.{ts,tsx}", "src/test/**"],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": "off",
      // 测试在 jsdom 下访问 document/window 等浏览器全局，react-hooks/globals
      // 会误报；该规则面向 React Compiler 的纯函数假设，对测试无意义。
      "react-hooks/globals": "off",
    },
  },
  {
    // 零依赖的构建/门禁脚本（Node 运行环境），需识别 process/console 等 Node 全局。
    files: ["scripts/**/*.mjs", "scripts/**/*.js"],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
  },
  {
    // 后端（server 工作区）：CommonJS + 纯 Node 运行环境，此前长期未被 lint 覆盖。
    // 仅挂 core JS 推荐规则 + Node 全局；TS 规则不介入（server 不依赖 TS）。
    files: ["server/**/*.js"],
    languageOptions: {
      sourceType: "commonjs",
      globals: serverNodeGlobals,
    },
    rules: {
      // CommonJS 以 require() 引入依赖，@typescript-eslint/no-require-imports 对 CJS 无意义。
      "@typescript-eslint/no-require-imports": "off",
      // 改用 core no-unused-vars，并允许 Express 错误中间件的 4 参签名里
      // 下划线前缀形参（如 _next / _err）按约定忽略，避免误报。
      "@typescript-eslint/no-unused-vars": "off",
      "no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
    },
  },
);
