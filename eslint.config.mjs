import js from "@eslint/js";
import globals from "globals";

/** Extension runtime scripts only. Vendored Transformers.js / ORT and tests are out of scope. */
const extensionFiles = [
  "chrome_plugin/background.js",
  "chrome_plugin/content.js",
  "chrome_plugin/offscreen.js",
  "chrome_plugin/popup.js",
];

export default [
  {
    ignores: [
      "chrome_plugin/lib/**",
      "node_modules/**",
    ],
  },
  {
    files: extensionFiles,
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "script",
      globals: {
        ...globals.browser,
        ...globals.webextensions,
      },
    },
    rules: {
      ...js.configs.recommended.rules,
      // Best-effort chrome/DOM calls intentionally swallow failures.
      "no-empty": ["error", { allowEmptyCatch: true }],
      "no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
        },
      ],
    },
  },
  {
    files: ["chrome_plugin/offscreen.js"],
    languageOptions: {
      sourceType: "module",
    },
  },
];
