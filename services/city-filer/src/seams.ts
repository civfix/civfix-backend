import { makeDb } from "@civfix/api/db"
import { R2Storage } from "@civfix/api/adapters/storage"
import { captureError, flushErrorReporting, initErrorReporting } from "@civfix/api/errors"
import { makeFilingsWorker, type FilingsWorker } from "@civfix/api/filings-worker"
import type { Storage } from "@civfix/seams"
import { required } from "./config.js"
import { PgBossFilerJobs, type FilerJobs } from "./jobs.js"

export interface FilerSeams {
  filings: FilingsWorker
  jobs: FilerJobs
  storage: Storage
  report: (err: unknown, context?: Record<string, unknown>) => void
  close(): Promise<void>
}

/** Real seams only: the filer runs in production alone (D10), so there is nothing to fake. */
export async function makeSeams(source: NodeJS.ProcessEnv = process.env): Promise<FilerSeams> {
  await initErrorReporting({
    ...(source.GLITCHTIP_DSN ? { dsn: source.GLITCHTIP_DSN } : {}),
    environment: source.NODE_ENV ?? "development",
    release: `city-filer@${source.SERVICE_VERSION ?? "0.0.0"}`,
  })
  const databaseUrl = required(source, "DATABASE_URL")
  const db = makeDb(databaseUrl)
  const storage = new R2Storage({
    accountId: required(source, "R2_ACCOUNT_ID"),
    accessKeyId: required(source, "R2_ACCESS_KEY_ID"),
    secretAccessKey: required(source, "R2_SECRET_ACCESS_KEY"),
    bucket: required(source, "R2_BUCKET"),
  })
  return {
    filings: makeFilingsWorker(db.sql),
    jobs: new PgBossFilerJobs(databaseUrl),
    storage,
    report: captureError,
    async close() {
      await db.close()
      await flushErrorReporting()
    },
  }
}
