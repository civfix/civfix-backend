import eslint from "@eslint/js"
import tseslint from "typescript-eslint"
import globals from "globals"

// Type-aware rules are enabled per service via `parserOptions.projectService` in the service's
// eslint.config.js, so this preset stays project-agnostic.
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
