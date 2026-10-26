import { defineConfig } from "tsup"

export default defineConfig({
  entry: {
    main: "src/main.ts",
    preflight: "src/preflight-main.ts",
  },
  outDir: "dist",
  format: ["esm"],
  target: "node22",
  platform: "node",
  dts: false,
  sourcemap: true,
  clean: true,
  splitting: false,
  noExternal: ["@civfix/api", "@civfix/contract", "@civfix/seams"],
  external: [
    "pg-boss",
    "postgres",
    "drizzle-orm",
    "@sentry/node",
    "https-proxy-agent",
    "@smithy/node-http-handler",
    /^@aws-sdk\//,
  ],
})
