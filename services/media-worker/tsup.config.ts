import { defineConfig } from "tsup"

export default defineConfig({
  entry: {
    main: "src/main.ts",
    worker: "src/worker.ts",
    "image-lane": "src/sandbox/image-lane-main.ts",
    "preflight-only": "src/preflight-only.ts",
  },
  outDir: "dist",
  format: ["esm"],
  target: "node22",
  platform: "node",
  dts: false,
  sourcemap: true,
  clean: true,
  splitting: false,
  noExternal: ["@civfix/api", "@civfix/shared"],
  external: [
    "sharp",
    "ffmpeg-static",
    "ffprobe-static",
    "execa",
    "exifr",
    "pg-boss",
    "postgres",
    "drizzle-orm",
    "@sentry/node",
    "undici",
    "https-proxy-agent",
    "@smithy/node-http-handler",
    /^@aws-sdk\//,
  ],
})
