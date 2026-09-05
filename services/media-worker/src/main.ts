import { start, makeShutdown, type Worker } from "./worker.js"

function installProcessFaultHandlers(worker: Worker): void {
  const shutdown = makeShutdown(worker, { exitCode: 1 })
  const fatal = (err: unknown, source: string): void => {
    worker.seams.report(err, { source })
    console.error("media-worker: fatal process error, stopping", { source, err: String(err) })
    void shutdown(source).catch(() => process.exit(1))
  }
  process.on("unhandledRejection", (reason: unknown) => fatal(reason, "unhandledRejection"))
  process.on("uncaughtException", (err: unknown) => fatal(err, "uncaughtException"))
}

start()
  .then(installProcessFaultHandlers)
  .catch((err: unknown) => {
    console.error("fatal: failed to start civfix media-worker", { err: String(err) })
    process.exit(1)
  })
