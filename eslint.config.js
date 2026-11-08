import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";

export default tseslint.config(
  {
    ignores: [
      "dist/**",
      "coverage/**",
      "node_modules/**",
      "server/**",
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
      "react-refresh/only-export-components": [
        "warn",
        { allowConstantExport: true },
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
);
