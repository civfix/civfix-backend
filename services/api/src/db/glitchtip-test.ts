import type { ErrorReportingOptions } from "../errors/glitchtip.js"
import { runIfMain } from "./cli.js"

export async function runGlitchtipTest(
  _transport?: ErrorReportingOptions["transport"],
): Promise<void> {
  throw new Error("not implemented")
}

runIfMain(import.meta.url, "glitchtip:test", () => runGlitchtipTest())
