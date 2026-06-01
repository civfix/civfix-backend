/**
 * civfix media worker.
 *
 * SCAFFOLD: constructs the Jobs seam and exposes a lifecycle (start/stop) with graceful shutdown,
 * but registers NO real handlers yet. The media-checks job (decode, EXIF strip, pHash, NSFW, video
 * transcode) lands in a later step, which will call `jobs.work("media-checks", handler)` inside
 * `registerHandlers` below.
 *
 * Kept dependency-light on purpose: sharp / exifr / ffmpeg are NOT pulled in here yet.
 */

import type { Jobs } from "@civfix/shared/interfaces"
import { buildJobs, type JobsHandle } from "./jobs.js"

export interface Worker {
  jobs: Jobs
  /** Start the queue and register handlers. */
  start(): Promise<void>
  /** Graceful shutdown: stop the queue. */
  stop(): Promise<void>
}

/**
 * Register job handlers. EXTENSION POINT for later steps: add `await jobs.work(name, handler)`
 * lines here. No-op in the scaffold.
 */
async function registerHandlers(_jobs: Jobs): Promise<void> {
  // <-- later: await _jobs.work("media-checks", mediaChecksHandler)
  return
}

/** Build the worker over a Jobs handle (defaults to one selected by USE_FAKE_JOBS). */
export function buildWorker(handle: JobsHandle = buildJobs()): Worker {
  let started = false

  async function start(): Promise<void> {
    if (started) return
    await handle.start()
    await registerHandlers(handle.jobs)
    started = true
  }

  async function stop(): Promise<void> {
    if (!started) {
      // Still attempt to stop the queue in case start() partially ran.
      await handle.stop()
      return
    }
    await handle.stop()
    started = false
  }

  return { jobs: handle.jobs, start, stop }
}

let shuttingDown = false

/** Start the worker and install SIGTERM/SIGINT graceful shutdown. */
export async function start(): Promise<Worker> {
  const worker = buildWorker()
  await worker.start()
  console.log("civfix media-worker started")

  async function shutdown(signal: string): Promise<void> {
    if (shuttingDown) return
    shuttingDown = true
    console.log(`media-worker: ${signal} received, stopping`)
    try {
      await worker.stop()
      process.exit(0)
    } catch (err) {
      console.error("media-worker: error during shutdown", err)
      process.exit(1)
    }
  }

  process.on("SIGTERM", () => void shutdown("SIGTERM"))
  process.on("SIGINT", () => void shutdown("SIGINT"))

  return worker
}
