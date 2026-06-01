/**
 * Drizzle schema barrel.
 *
 * Schema tables land in later steps (reports, cleanups, users, etc.). For now this exports an empty
 * object so `import * as schema from "./schema/index.js"` resolves and `drizzle({ schema })` is
 * happy with zero tables. Each domain step appends its table modules here.
 */

export {}
