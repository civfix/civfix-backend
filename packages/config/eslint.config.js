import eslint from "@eslint/js"
import tseslint from "typescript-eslint"
import globals from "globals"
import vitest from "@vitest/eslint-plugin"

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
      "@typescript-eslint/no-deprecated": "error",
      "@typescript-eslint/no-unsafe-enum-comparison": "error",
      "@typescript-eslint/no-misused-spread": "error",
      "@typescript-eslint/no-dynamic-delete": "error",
      "@typescript-eslint/prefer-nullish-coalescing": "error",
      "@typescript-eslint/restrict-plus-operands": [
        "error",
        {
          allowAny: false,
          allowBoolean: false,
          allowNullish: false,
          allowNumberAndString: false,
          allowRegExp: false,
        },
      ],
      "@typescript-eslint/use-unknown-in-catch-callback-variable": "error",
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
    ...tseslint.configs.recommendedTypeChecked,
    {
      files: ["**/*.{js,mjs,cjs}"],
      ...tseslint.configs.disableTypeChecked,
    },
    {
      linterOptions: { reportUnusedDisableDirectives: "error" },
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
        // Measured hits are nearly all correct code: async fakes and handlers that satisfy a
        // Promise-returning interface without awaiting, and methods passed as callbacks that never
        // touch `this`.
        "@typescript-eslint/require-await": "off",
        "@typescript-eslint/unbound-method": "off",
        // Relaxed outside src by decision: test doubles and fixtures lean on loose casts.
        "@typescript-eslint/no-unsafe-argument": "off",
        "@typescript-eslint/no-unsafe-assignment": "off",
        "@typescript-eslint/no-unsafe-call": "off",
        "@typescript-eslint/no-unsafe-member-access": "off",
        "@typescript-eslint/no-unsafe-return": "off",
      },
    },
    {
      files: ["src/**/*.ts"],
      rules: {
        "@typescript-eslint/no-explicit-any": "error",
        "@typescript-eslint/no-unsafe-argument": "error",
        "@typescript-eslint/no-unsafe-assignment": "error",
        "@typescript-eslint/no-unsafe-call": "error",
        "@typescript-eslint/no-unsafe-member-access": "error",
        "@typescript-eslint/no-unsafe-return": "error",
        "@typescript-eslint/no-non-null-assertion": "error",
      },
    },
    {
      files: ["test/**/*.ts"],
      plugins: { vitest },
      rules: {
        "vitest/no-focused-tests": "error",
        // Flags `.skip` and `x*` only; the `skipIf(!pg)` guards on the Postgres suites stay legal.
        "vitest/no-disabled-tests": "error",
        "vitest/valid-expect": ["error", { maxArgs: 2 }],
        // Shared helpers that assert are named expect* (expectAppError, expect404, expectConsoleError).
        "vitest/expect-expect": ["error", { assertFunctionNames: ["expect", "expect*", "assert"] }],
      },
    },
    ...extra,
  )
}

export default config()
