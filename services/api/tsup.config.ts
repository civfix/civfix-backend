import { defineConfig } from "tsup"

export default defineConfig({
  // main.ts: the HTTP server entrypoint. server.ts: the factory (imported by tests/embedding).
  // db/migrate.ts: the migration runner, emitted so the PRODUCTION image can run it WITHOUT tsx (the
  //   deploy sequence runs `node dist/db/migrate.js` before the API serves; see README + the compose
  //   `migrate` init service). It applies services/api/drizzle/0000..0004 in order, idempotently.
  entry: ["src/main.ts", "src/server.ts", "src/db/migrate.ts"],
  outDir: "dist",
  format: ["esm"],
  target: "node22",
  platform: "node",
  dts: false,
  sourcemap: true,
  clean: true,
  splitting: false,
  // Keep all deps external; this is a service, not a library bundle.
  skipNodeModulesBundle: true,
})
