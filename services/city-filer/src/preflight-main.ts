import { readFile } from "node:fs/promises"
import { lookupUid, WORKSPACE_DIR } from "./config.js"
import { IMAGE_RUNNER } from "./filer-process.js"
import { runPreflight } from "./preflight.js"

// #178's smoke runs this in the built image; a non-zero exit fails it.
const nodeUid = lookupUid("node")
if (nodeUid === null) {
  console.error("city-filer: preflight FAILED: the image has no node user")
  process.exit(1)
}
process.exit(
  await runPreflight({
    runner: IMAGE_RUNNER,
    workspaceDir: WORKSPACE_DIR,
    ownStatus: () => readFile("/proc/self/status", "utf8"),
    nodeUid,
    env: process.env,
    mcpDir: "/usr/local/lib/node_modules/@playwright/mcp",
    log: (line) => console.log(line),
  }),
)
