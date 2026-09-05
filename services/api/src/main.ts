import type { FastifyInstance } from "fastify"
import { start, makeShutdown } from "./server.js"

function installProcessFaultHandlers(app: FastifyInstance): void {
  const shutdown = makeShutdown(app, { exitCode: 1 })
  const fatal = (err: unknown, source: string): void => {
    app.log.error({ err, source }, "fatal: unhandled process error, draining")
    void shutdown(source).catch(() => process.exit(1))
  }
  process.on("unhandledRejection", (reason: unknown) => fatal(reason, "unhandledRejection"))
  process.on("uncaughtException", (err: unknown) => fatal(err, "uncaughtException"))
}

start()
  .then(installProcessFaultHandlers)
  .catch((err: unknown) => {
    console.error("fatal: failed to start civfix-api")
    console.error(err)
    process.exit(1)
  })
