import { defineConfig } from "drizzle-kit"

/**
 * Drizzle Kit config. Schema tables live under src/db/schema; generated SQL goes to ./drizzle.
 * Reads DATABASE_URL from the environment. `pnpm db:generate` produces migrations; with no tables
 * defined yet it is a no-op.
 */
export default defineConfig({
  schema: "./src/db/schema/index.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "",
  },
  strict: true,
  verbose: true,
})
