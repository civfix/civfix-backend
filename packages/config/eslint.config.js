import eslint from "@eslint/js"
import tseslint from "typescript-eslint"
import globals from "globals"

/**
 * Shared ESLint flat-config preset for civfix backend services.
 *
 * Services extend it like:
 *   import { config } from "@civfix/config/eslint"
 *   export default config()
 *
 * `config()` returns a flat-config array. Pass extra config objects to append service-specific
 * overrides. Type-aware rules are enabled per service by setting `parserOptions.projectService`
 * in the service eslint.config.js; this preset stays project-agnostic so it works everywhere.
 */
export function config(...extra) {
  return tseslint.config(
    {
      ignores: [
        "dist/**",
        "node_modules/**",
        ".turbo/**",
        "coverage/**",
        "drizzle/**",
        "*.config.js",
        "*.config.ts",
      ],
    },
    eslint.configs.recommended,
    ...tseslint.configs.recommended,
    {
      languageOptions: {
        ecmaVersion: 2022,
        sourceType: "module",
        globals: {
          ...globals.node,
        },
      },
      rules: {
        "no-console": "off",
        "@typescript-eslint/no-explicit-any": "off",
        "@typescript-eslint/no-unused-vars": [
          "error",
          {
            argsIgnorePattern: "^_",
            varsIgnorePattern: "^_",
            caughtErrorsIgnorePattern: "^_",
          },
        ],
        "@typescript-eslint/consistent-type-imports": [
          "error",
          { prefer: "type-imports", disallowTypeAnnotations: false },
        ],
      },
    },
    ...extra,
  )
}

export default config()
