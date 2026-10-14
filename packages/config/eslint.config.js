import eslint from "@eslint/js"
import tseslint from "typescript-eslint"
import globals from "globals"

// Type-aware rules need a TypeScript program, which only the consuming service can locate, so each
// service passes its own parserOptions (projectService + tsconfigRootDir) through `typed()`.
export function typed(parserOptions) {
  return {
    files: ["**/*.ts"],
    languageOptions: { parserOptions },
    rules: {
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/await-thenable": "error",
      "@typescript-eslint/no-for-in-array": "error",
      "@typescript-eslint/no-implied-eval": "error",
      "@typescript-eslint/only-throw-error": "error",
      "@typescript-eslint/prefer-promise-reject-errors": "error",
      "@typescript-eslint/restrict-template-expressions": [
        "error",
        { allowNumber: true, allowBoolean: true },
      ],
      "@typescript-eslint/no-base-to-string": "error",
      "@typescript-eslint/no-redundant-type-constituents": "error",
      "@typescript-eslint/switch-exhaustiveness-check": [
        "error",
        { considerDefaultExhaustiveForUnions: true },
      ],
      "@typescript-eslint/no-unnecessary-type-assertion": "error",
    },
  }
}

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
