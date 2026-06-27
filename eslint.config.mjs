import js from "@eslint/js";
import globals from "globals";

export default [
  js.configs.recommended,
  {
    ignores: ["js/lib/", "node_modules/"],
  },
  // Browser/client JS (ES modules)
  {
    files: ["js/**/*.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: {
        ...globals.browser,
        d3: "readonly",
      },
    },
    rules: {
      "no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
      "no-console": "off",
      "prefer-const": "warn",
      "no-var": "error",
      "eqeqeq": ["warn", "always"],
      "curly": ["warn", "multi-line"],
    },
  },
  // Server-side CommonJS files
  {
    files: ["server.js", "server/**/*.js", "sw.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "commonjs",
      globals: {
        ...globals.node,
        ...globals.serviceworker,
      },
    },
    rules: {
      "no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
      "no-console": "off",
      "prefer-const": "warn",
      "no-var": "error",
      "eqeqeq": ["warn", "always"],
      "curly": ["warn", "multi-line"],
      "no-empty": ["error", { "allowEmptyCatch": true }],
    },
  },
];
