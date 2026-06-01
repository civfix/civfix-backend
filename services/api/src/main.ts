/**
 * Process entrypoint. Loads env (failing loudly on misconfiguration) and starts the server.
 */

import { start } from "./server.js"

start().catch((err: unknown) => {
  // Last-resort handler: env load failure or listen failure. Print and exit non-zero.
  console.error("fatal: failed to start civfix-api")
  console.error(err)
  process.exit(1)
})
