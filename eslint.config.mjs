import js from "@eslint/js";
import globals from "globals";

export default [
  js.configs.recommended,
  {
    ignores: ["js/lib/", "node_modules/", ".gstack/"],
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
  // Server-side CommonJS files (server + operational scripts)
  {
    files: ["server.js", "server/**/*.js", "server/**/*.cjs", "scripts/**/*.js", "sw.js", "mcp/**/*.js"],
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
  {
    files: ["server/**/*.test.js", "mcp/**/*.test.js"],
    languageOptions: { sourceType: "module" },
  },
  // QA test scripts use Playwright's CommonJS API in a browser test runtime.
  {
    files: ["scripts/qa/**/*.cjs"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "commonjs",
      globals: {
        ...globals.node,
        ...globals.browser,
      },
    },
    rules: {
      // The scripts retain explicit /* global */ headers for editors.
      "no-redeclare": "off",
    },
  },
  // Client-side tests execute in vitest, whose runtime exposes Node globals.
  {
    files: ["js/**/__tests__/**/*.js"],
    languageOptions: {
      globals: { ...globals.node },
    },
  },
];
