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
        // Measured at ~1,400 and ~140 hits, nearly all correct code: async fakes and handlers that
        // satisfy a Promise-returning interface without awaiting, and methods passed as callbacks
        // that never touch `this`.
        "@typescript-eslint/require-await": "off",
        "@typescript-eslint/unbound-method": "off",
        // Tests stay relaxed here for good. In src the ~90 hits sit almost all on the untyped push
        // and SMS SDK imports and the ws socket; they come on once those get typed shims.
        "@typescript-eslint/no-unsafe-argument": "off",
        "@typescript-eslint/no-unsafe-assignment": "off",
        "@typescript-eslint/no-unsafe-call": "off",
        "@typescript-eslint/no-unsafe-member-access": "off",
        "@typescript-eslint/no-unsafe-return": "off",
      },
    },
    ...extra,
  )
}

export default config()
