import { consoleLog, loadConfig } from "./config.js"
import { startFiler } from "./filer.js"
import { IMAGE_RUNNER } from "./filer-process.js"
import { makeSeams } from "./seams.js"

const config = loadConfig()
const seams = await makeSeams()
await seams.jobs.start()
const filer = await startFiler({ ...seams, config, runner: IMAGE_RUNNER, log: consoleLog })
consoleLog("city-filer: working filing.run", { dryRun: config.dryRun })

let stopping = false
async function shutdown(signal: string): Promise<void> {
  if (stopping) return
  stopping = true
  consoleLog("city-filer: stopping", { signal })
  await filer.stop()
  await seams.close()
  process.exit(0)
}
process.on("SIGTERM", () => void shutdown("SIGTERM"))
process.on("SIGINT", () => void shutdown("SIGINT"))
