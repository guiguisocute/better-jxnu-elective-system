import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";

export default tseslint.config(
  // plan/ 是设计稿快照（独立小项目），不参与本项目 lint。
  { ignores: ["dist", "node_modules", "plan"] },
  {
    files: ["**/*.{ts,tsx}"],
    extends: [
      js.configs.recommended,
      ...tseslint.configs.recommended,
    ],
    languageOptions: {
      ecmaVersion: 2022,
      globals: globals.browser,
    },
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      // 只启用经典两条 hooks 规则。v7 recommended 全家桶自带的 compiler 系
      // 新规则（set-state-in-effect 等）与本仓库既有的 effect 桥接惯用法冲突，暂不启用。
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
      "react-refresh/only-export-components": ["warn", { allowConstantExport: true }],
      // 空 catch {} 在本仓库是惯用法（storage 访问兜底），不视为错误。
      "no-empty": ["error", { allowEmptyCatch: true }],
      // JSX 文案里的全角空格（U+3000）是有意的排版手段。
      "no-irregular-whitespace": ["error", { skipJSXText: true, skipStrings: true }],
    },
  },
);
