import { randomUUID } from "node:crypto"
import { chmod, chown, lstat, mkdir, writeFile } from "node:fs/promises"
import { extname, join } from "node:path"
import type {
  FilingResultPayload,
  FilingRunPacket,
  FilingsWorker,
} from "@civfix/api/filings-worker"
import type { JobHandler, Jobs, Storage } from "@civfix/seams"
import { z } from "zod"
import type { FilerConfig, FilerLog } from "./config.js"
import type { FilerRunner } from "./filer-process.js"
import { sendFilingResult } from "./hand-back.js"
import { collectEvidence, runEnding } from "./output.js"
import { isPortalHost, readPortalScript, runScript, SUBMIT_MARKER } from "./script.js"

const PHOTO_MAX_BYTES = 10 * 1024 * 1024

export interface FilingRunDeps {
  filings: Pick<
    FilingsWorker,
    "getFilingSettings" | "claimFiling" | "isReportFileable" | "loadRunPacket"
  >
  jobs: Pick<Jobs, "enqueue">
  storage: Pick<Storage, "getObject" | "put">
  config: FilerConfig
  runner: FilerRunner
  log: FilerLog
  report: (err: unknown, context?: Record<string, unknown>) => void
}

const FilingRunJobSchema = z.object({ filingId: z.uuid(), attempt: z.number().int().positive() })

type Ending = Omit<FilingResultPayload, "filingId" | "runId" | "attempt" | "dryRun" | "evidence"> &
  Partial<Pick<FilingResultPayload, "evidence">>

interface Run {
  filingId: string
  runId: string
  attempt: number
  dir: string
}

const portalError: Ending = { outcome: "failed", reason: "portal_error" }

/** The `filing.run` handler: one attempt of one portal filing (D6, D7). */
export function makeFilingRunHandler(deps: FilingRunDeps): JobHandler {
  const { config, log } = deps

  // node owns every entry and hands it to the filer group, which may read it; only out/ is writable to
  // filer, and its setgid bit keeps what filer writes there in the group node can delete.
  async function own(path: string, mode: number): Promise<void> {
    if (config.filerGid !== null) await chown(path, -1, config.filerGid)
    await chmod(path, mode)
  }

  async function writeOwned(path: string, bytes: Uint8Array | string, mode: number): Promise<void> {
    await writeFile(path, bytes, { flag: "wx", mode })
    await own(path, mode)
  }

  /** False when the directory was already there: a run never reuses one (D7). */
  async function prepareRunDir(
    run: Run,
    packet: FilingRunPacket & { formUrl: string },
  ): Promise<boolean> {
    try {
      await mkdir(run.dir, { mode: 0o750 })
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") return false
      throw err
    }
    await own(run.dir, 0o750)
    const runPacket = {
      ticketText: packet.ticketText,
      location: { addr: packet.addr, lat: packet.lat, lng: packet.lng },
      category: packet.category,
      requestTypeHint: packet.requestTypeHint,
      startUrl: packet.formUrl,
      contact: config.contact,
      dryRun: config.dryRun,
    }
    await writeOwned(join(run.dir, "packet.json"), JSON.stringify(runPacket, null, 2), 0o640)
    await mkdir(join(run.dir, "photos"))
    await own(join(run.dir, "photos"), 0o750)
    let n = 0
    for (const photo of packet.photos) {
      if (photo.byteSize !== null && photo.byteSize > PHOTO_MAX_BYTES) continue
      const bytes = await deps.storage.getObject(photo.servedKey)
      if (bytes === null || bytes.byteLength > PHOTO_MAX_BYTES) continue
      const ext = extname(photo.servedKey).toLowerCase()
      n += 1
      await writeOwned(
        join(run.dir, "photos", `${n}${/^\.[a-z0-9]{1,5}$/.test(ext) ? ext : ""}`),
        bytes,
        0o640,
      )
    }
    await mkdir(join(run.dir, "out"))
    await own(join(run.dir, "out"), 0o2770)
    return true
  }

  async function uploadEvidence(
    run: Run,
    names: string[],
    script: Buffer,
  ): Promise<FilingResultPayload["evidence"]> {
    const files = await collectEvidence(join(run.dir, "out"), names, log)
    const uploads = [
      ...files.map((f) => ({ ...f, kind: "screenshot" as const, label: f.name })),
      {
        bytes: script,
        ext: "mjs",
        contentType: "text/javascript",
        kind: "script" as const,
        label: "script.mjs",
      },
    ]
    const evidence: FilingResultPayload["evidence"] = []
    for (const upload of uploads) {
      const r2Key = `filings/${run.filingId}/${randomUUID()}.${upload.ext}`
      try {
        await deps.storage.put(r2Key, upload.bytes, { contentType: upload.contentType })
        evidence.push({ r2Key, kind: upload.kind, label: upload.label })
      } catch (err) {
        // The outcome still goes back: a filing the city may have must not wait on a screenshot.
        deps.report(err, { filingId: run.filingId, label: upload.label })
        log("filer: evidence upload failed", { filingId: run.filingId, label: upload.label })
      }
    }
    return evidence
  }

  async function attempt(run: Run): Promise<Ending> {
    if (!(await deps.filings.isReportFileable(run.filingId))) return { outcome: "cancelled" }
    const packet = await deps.filings.loadRunPacket(run.filingId)
    if (packet === null) throw new Error(`filing ${run.filingId} vanished after its claim`)
    const { portalHost: host, formUrl } = packet
    if (host === null || formUrl === null || !isPortalHost(host)) {
      log("filer: the filing has no usable portal", { filingId: run.filingId })
      return portalError
    }
    if (!(await prepareRunDir(run, { ...packet, formUrl }))) {
      log("filer: the run directory already exists", { filingId: run.filingId, runId: run.runId })
      return portalError
    }
    const script = await readPortalScript(config.workspaceDir, host)
    // Until #177 brings Claude, a portal with no script waits as "Claude unavailable" (D6).
    if (script.kind === "missing") return { outcome: "failed", reason: "ai_unavailable" }
    if (script.kind === "rejected") {
      log("filer: the portal script was not read", {
        filingId: run.filingId,
        host,
        why: script.why,
      })
      return portalError
    }
    const ran = await runScript(deps.runner, {
      runDir: run.dir,
      host,
      dryRun: config.dryRun,
      scriptSha256: script.sha256,
      timeoutMs: config.scriptTimeoutMs,
    })
    log("filer: script finished", { filingId: run.filingId, runId: run.runId, ...ran })
    const outDir = join(run.dir, "out")
    const { evidenceNames, ...ending } = await runEnding({
      outDir,
      host,
      dryRun: config.dryRun,
      run: ran,
      log,
    })
    const evidence = await uploadEvidence(run, evidenceNames, script.bytes)
    return { ...ending, scriptVersion: script.version, evidence }
  }

  return async (job) => {
    const { filingId, attempt: n } = FilingRunJobSchema.parse(job.data)
    if ((await deps.filings.getFilingSettings()).paused) return
    const claim = await deps.filings.claimFiling(filingId, n)
    if (claim === null) return
    const dir = join(config.workspaceDir, "runs", `${filingId}-${claim.runId}`)
    const run: Run = { filingId, runId: claim.runId, attempt: n, dir }
    let ending: Ending
    try {
      ending = await attempt(run)
    } catch (err) {
      deps.report(err, { filingId, runId: run.runId })
      const marker = await lstat(join(dir, "out", SUBMIT_MARKER)).then(
        () => true,
        () => false,
      )
      ending = { outcome: "failed", reason: marker ? "uncertain_submission" : "portal_error" }
    }
    await sendFilingResult(deps.jobs, {
      filingId,
      runId: run.runId,
      attempt: n,
      dryRun: config.dryRun,
      evidence: [],
      ...ending,
    })
  }
}
