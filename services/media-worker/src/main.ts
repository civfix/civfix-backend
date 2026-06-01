/**
 * Media worker process entrypoint.
 */

import { start } from "./worker.js"

start().catch((err: unknown) => {
  console.error("fatal: failed to start civfix media-worker")
  console.error(err)
  process.exit(1)
})
