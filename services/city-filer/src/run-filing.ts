import { randomUUID } from "node:crypto"
import { chmod, chown, lstat, mkdir, rename, writeFile } from "node:fs/promises"
import { extname, join } from "node:path"
import type {
  FilingResultPayload,
  FilingRunPacket,
  FilingsWorker,
} from "@civfix/api/filings-worker"
import type { JobHandler, Jobs, Storage } from "@civfix/seams"
import { z } from "zod"
import {
  CLAUDE_RUN_TIMEOUT_MS,
  filingRunArgs,
  PLAYWRIGHT_MCP_SERVER,
  runClaude,
  type ClaudeGate,
} from "./claude.js"
import type { FilerConfig, FilerLog } from "./config.js"
import type { FilerRunner } from "./filer-process.js"
import { confineToHost, workspaceHead } from "./git.js"
import { sendFilingResult } from "./hand-back.js"
import { collectEvidence, runEnding, type RunEnding } from "./output.js"
import { forgetProved, readProved, recordProved } from "./proved.js"
import {
  isPortalHost,
  readPortalScript,
  runScript,
  SUBMIT_MARKER,
  type PortalScript,
  type ScriptRunResult,
} from "./script.js"

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
  gate: ClaudeGate
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

type OkScript = Extract<PortalScript, { kind: "ok" }>

/** A run whose filing has a usable portal host. */
type PortalRun = Run & { host: string }

// Claude's out/result.json is judged as a cleanly exited script's would be; only its needs_human counts.
const CLEAN_EXIT: ScriptRunResult = { exitCode: 0, timedOut: false, sentinel: false, marker: false }

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

  /** Moves out/ aside as `name` and gives the next step a fresh one; nothing filer left there carries on. */
  async function freshOut(run: Run, name: "out-live" | "out-claude" | "out-proof"): Promise<void> {
    await rename(join(run.dir, "out"), join(run.dir, name))
    await mkdir(join(run.dir, "out"))
    await own(join(run.dir, "out"), 0o2770)
  }

  /** One run of the script as filer, and what it ended as; with `dryRun` false it may submit. */
  async function runOnce(run: PortalRun, script: OkScript, dryRun: boolean, step = "script") {
    const { host } = run
    const ran = await runScript(deps.runner, {
      ...{ runDir: run.dir, host, dryRun, scriptSha256: script.sha256 },
      timeoutMs: config.scriptTimeoutMs,
    })
    log(`filer: ${step} finished`, { filingId: run.filingId, runId: run.runId, ...ran })
    const ending = await runEnding({ outDir: join(run.dir, "out"), host, dryRun, run: ran, log })
    return { ran, ending }
  }

  /** The ending handed back: out/'s listed evidence and a copy of the exact script bytes that ran. */
  async function withEvidence(run: Run, script: OkScript, ending: RunEnding): Promise<Ending> {
    const { evidenceNames, ...rest } = ending
    const evidence = await uploadEvidence(run, evidenceNames, script.bytes)
    return { ...rest, scriptVersion: script.version, evidence }
  }

  /**
   * D7 step 4: Claude writes or repairs the host's script, then the wrapper confines its changes, proves the
   * script with its own dry run and runs it live once. Claude never presses the live submit.
   */
  async function withClaude(
    run: PortalRun,
    before: PortalScript,
    why: "missing" | "unproved" | "failed",
  ): Promise<Ending> {
    const { host } = run
    const gitDeps = { runner: deps.runner, workspaceDir: config.workspaceDir, log }
    const base = await workspaceHead(gitDeps)
    const mcpConfig = join(run.dir, "mcp.json")
    const servers = { mcpServers: { playwright: PLAYWRIGHT_MCP_SERVER } }
    await writeOwned(mcpConfig, JSON.stringify(servers, null, 2), 0o640)
    const prompt = [
      `Portal host: ${host}`,
      `Run directory: ${run.dir}`,
      `Packet: ${join(run.dir, "packet.json")}`,
      `Filing id: ${run.filingId}`,
      {
        missing: `There is no script for ${host} yet. Write portals/${host}/script.mjs.`,
        unproved: `portals/${host}/script.mjs has not passed the wrapper's dry run as it is. Check it and repair it if needed.`,
        failed: `portals/${host}/script.mjs failed before its submit; that run's output is in out-live/. Repair it.`,
      }[why],
    ].join("\n")
    const claude = await runClaude(
      { runner: deps.runner, gate: deps.gate, log },
      {
        args: filingRunArgs(config.runModel, mcpConfig),
        stdin: `${prompt}\n`,
        cwd: run.dir,
        run: { dir: run.dir, host },
        timeoutMs: CLAUDE_RUN_TIMEOUT_MS,
      },
    )
    log("filer: claude finished", {
      filingId: run.filingId,
      runId: run.runId,
      ...(claude.kind === "ok"
        ? { ok: true }
        : { ok: false, reason: claude.reason, why: claude.why }),
    })

    await freshOut(run, "out-claude")
    const outDir = join(run.dir, "out-claude")
    const claimed = await runEnding({ outDir, host, dryRun: false, run: CLEAN_EXIT, log })
    if (!(await confineToHost(gitDeps, { base, host, filingId: run.filingId }))) return portalError
    if (claude.kind === "failed") return { outcome: "failed", reason: claude.reason }

    const script = await readPortalScript(config.workspaceDir, host)
    const untouched =
      script.kind === "missing" ||
      (before.kind === "ok" && script.kind === "ok" && script.sha256 === before.sha256)
    // Claude's own needs_human counts only when it left the script as it was; a changed script has to
    // pass the proof like any other.
    if (claimed.outcome === "needs_human" && untouched) {
      const { evidenceNames, ...ending } = claimed
      void evidenceNames
      return ending
    }
    if (script.kind !== "ok") {
      log("filer: claude left no usable script", { filingId: run.filingId, host })
      return portalError
    }

    // The proof is the wrapper's own dry run (D8): only the kit's sentinel on this pipe, carrying the
    // sha256 of the bytes read above, counts.
    const { ran: proof, ending } = await runOnce(run, script, true, "proof")
    if (proof.timedOut || proof.exitCode !== 0 || !proof.sentinel) {
      await forgetProved(config.workspaceDir, [host], log, "its proof failed")
      return portalError
    }
    await recordProved(config.workspaceDir, host, script.sha256)
    if (config.dryRun) return withEvidence(run, script, ending)

    await freshOut(run, "out-proof")
    const live = await readPortalScript(config.workspaceDir, host)
    if (live.kind !== "ok" || live.sha256 !== script.sha256) {
      log("filer: the script changed after its proof", { filingId: run.filingId, host })
      return portalError
    }
    return withEvidence(run, live, (await runOnce(run, live, false)).ending)
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
    if (script.kind === "rejected") {
      log("filer: the portal script was not read", {
        filingId: run.filingId,
        host,
        why: script.why,
      })
      return portalError
    }
    const portal = { ...run, host }
    if (script.kind === "missing") return withClaude(portal, script, "missing")
    // Only a script whose exact bytes passed the wrapper's proof runs live without Claude (D7 step 3).
    if ((await readProved(config.workspaceDir, host)) !== script.sha256) {
      return withClaude(portal, script, "unproved")
    }
    const { ending } = await runOnce(portal, script, config.dryRun)
    // Before the marker nothing reached the city, so Claude may repair the script in this attempt (D7).
    if (ending.outcome !== "failed" || ending.reason !== "portal_error") {
      return withEvidence(run, script, ending)
    }
    await freshOut(run, "out-live")
    return withClaude(portal, script, "failed")
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
