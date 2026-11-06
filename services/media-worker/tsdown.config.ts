import { defineConfig, type UserConfig } from "tsdown"

// One build per entry: Rolldown splits the modules several entries share into chunks of their own,
// and the entries must stay self-contained files, each a whole program.
function perEntry({
  entry,
  ...shared
}: Omit<UserConfig, "entry"> & { entry: Record<string, string> }): UserConfig[] {
  return Object.entries(entry).map(([name, source]) => ({ ...shared, entry: { [name]: source } }))
}

export default defineConfig(
  perEntry({
    entry: {
      main: "src/main.ts",
      worker: "src/worker.ts",
      "image-lane": "src/sandbox/image-lane-main.ts",
      "preflight-only": "src/preflight-only.ts",
    },
    outDir: "dist",
    format: "esm",
    fixedExtension: false,
    target: "node24",
    platform: "node",
    dts: false,
    sourcemap: true,
    outputOptions: {
      codeSplitting: false,
      // The image runs with --enable-source-maps, and Node keeps every loaded map in memory for the life
      // of the process. Stack remapping needs only the mappings, so the sources are not embedded.
      sourcemapExcludeSources: true,
    },
    deps: {
      alwaysBundle: [/^@civfix\/(api|contract|seams)(\/|$)/],
      // The one registry package inlined; anything else from node_modules stays external.
      onlyBundle: ["@civfix/contract"],
      neverBundle: [
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
    },
  }),
)
