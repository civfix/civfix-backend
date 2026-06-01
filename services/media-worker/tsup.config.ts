import { defineConfig } from "tsup"

/**
 * Build the worker into a self-contained dist.
 *
 * The worker imports the civfix data layer (schema, client, repo, R2 adapter, GlitchTip) from
 * @civfix/api via SOURCE-pointing package exports (services/api/package.json -> "./db" etc.). For the
 * production bundle we therefore inline the workspace packages (@civfix/api, @civfix/shared) so the
 * dist runs without those packages being separately built. Native / heavy runtime deps stay EXTERNAL
 * (they ship their own binaries or are large vendor SDKs and must be resolved from node_modules):
 *   sharp, ffmpeg-static, ffprobe-static (native binaries)
 *   execa, exifr, pg-boss, postgres, drizzle-orm
 *   @sentry/node, @aws-sdk/* (pulled in lazily by the API adapters)
 */
export default defineConfig({
  entry: ["src/main.ts", "src/worker.ts"],
  outDir: "dist",
  format: ["esm"],
  target: "node22",
  platform: "node",
  dts: false,
  sourcemap: true,
  clean: true,
  splitting: false,
  // Inline the workspace contract/data-layer packages so the dist is self-contained.
  noExternal: ["@civfix/api", "@civfix/shared"],
  // Everything else (native binaries, heavy SDKs, drivers) stays external.
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
    /^@aws-sdk\//,
  ],
})
