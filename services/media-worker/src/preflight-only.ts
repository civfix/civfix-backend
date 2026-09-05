import { assertSandboxPreflight } from "./sandbox/preflight.js"

assertSandboxPreflight().then(
  () => {
    process.exit(0)
  },
  (err: unknown) => {
    console.error("media-worker: sandbox preflight FAILED")
    console.error(err)
    process.exit(1)
  },
)
