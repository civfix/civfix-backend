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
      preflight: "src/preflight-main.ts",
    },
    outDir: "dist",
    format: "esm",
    fixedExtension: false,
    target: "node24",
    platform: "node",
    dts: false,
    sourcemap: true,
    outputOptions: { codeSplitting: false },
    deps: {
      alwaysBundle: [/^@civfix\/(api|contract|seams)(\/|$)/],
      // The one registry package inlined; anything else from node_modules stays external.
      onlyBundle: ["@civfix/contract"],
      neverBundle: [
        "pg-boss",
        "postgres",
        "drizzle-orm",
        "@sentry/node",
        "https-proxy-agent",
        "@smithy/node-http-handler",
        /^@aws-sdk\//,
      ],
    },
  }),
)
