import { it } from "vitest"
console.time("import-server")
await import("../../src/server.js")
console.timeEnd("import-server")
it("noop", () => {})
