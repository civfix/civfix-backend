import { existsSync } from "node:fs"
import { access, constants } from "node:fs/promises"
import type { SandboxIdentity } from "../config.js"
import { loadLimits } from "../config.js"
import { resolveMediaToolPaths } from "./binaries.js"
import { imageLaneEntry, processImageLane } from "./image-lane.js"
import { dropBoundingSet, runTool, sandboxIdentity } from "./exec.js"
import { makeScratch } from "./tmp.js"

const PREFLIGHT_TIMEOUT_MS = 10_000

const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQI12NgZGIGAAAOAAcGTPsnAAAAAElFTkSuQmCC",
  "base64",
)
const STATUS_READER = "/bin/cat"
const PROC_STATUS = "/proc/self/status"

const ALLOWED_BOUNDING_MASK = (1n << 7n) | (1n << 6n)

export type PreflightLog = (msg: string, fields?: Record<string, unknown>) => void

export interface SandboxProof {
  uid: number[]
  gid: number[]
  caps: Record<string, bigint>
}

export function parseProcStatus(text: string): SandboxProof {
  const ids = (label: string): number[] => {
    const line = text.split("\n").find((l) => l.startsWith(`${label}:`))
    if (!line) return []
    return line
      .slice(label.length + 1)
      .trim()
      .split(/\s+/)
      .map((v) => Number.parseInt(v, 10))
  }
  const caps: Record<string, bigint> = {}
  for (const name of ["CapInh", "CapPrm", "CapEff", "CapAmb", "CapBnd"]) {
    const line = text.split("\n").find((l) => l.startsWith(`${name}:`))
    if (line === undefined) continue
    const hex = line.slice(name.length + 1).trim()
    caps[name] = /^[0-9a-f]+$/i.test(hex) ? BigInt(`0x${hex}`) : -1n
  }
  return { uid: ids("Uid"), gid: ids("Gid"), caps }
}

export interface SandboxProofContext {
  parentUid: number | undefined
  parentGid: number | undefined
  boundingMustBeZero?: boolean
}

export function sandboxProofFailure(
  text: string,
  identity: SandboxIdentity,
  context: SandboxProofContext,
): string | null {
  const proof = parseProcStatus(text)

  const { parentUid, parentGid } = context
  if (parentUid !== undefined && proof.uid.some((v) => v === parentUid)) {
    return `child Uid [${proof.uid.join(" ")}] still contains the worker's own uid ${parentUid}`
  }
  if (parentGid !== undefined && proof.gid.some((v) => v === parentGid)) {
    return `child Gid [${proof.gid.join(" ")}] still contains the worker's own gid ${parentGid}`
  }

  if (proof.uid.length !== 4 || proof.uid.some((v) => v !== identity.uid)) {
    return `child Uid is [${proof.uid.join(" ")}], expected all four ids to be ${identity.uid}`
  }
  if (proof.gid.length !== 4 || proof.gid.some((v) => v !== identity.gid)) {
    return `child Gid is [${proof.gid.join(" ")}], expected all four ids to be ${identity.gid}`
  }

  for (const name of ["CapInh", "CapPrm", "CapEff", "CapAmb"]) {
    const value = proof.caps[name]
    if (value === undefined) return `child /proc/self/status has no ${name} line`
    if (value !== 0n) return `child ${name} is ${value.toString(16)}, expected 0`
  }

  const bounding = proof.caps.CapBnd
  if (bounding === undefined) return "child /proc/self/status has no CapBnd line"
  if (context.boundingMustBeZero === true) {
    if (bounding !== 0n) return `child CapBnd is ${bounding.toString(16)}, expected 0`
  } else if ((bounding & ~ALLOWED_BOUNDING_MASK) !== 0n) {
    return (
      `child CapBnd is ${bounding.toString(16)}, which contains capabilities beyond ` +
      "CAP_SETUID/CAP_SETGID (the container's own grant)"
    )
  }
  return null
}

export async function assertSandboxPreflight(
  source: NodeJS.ProcessEnv = process.env,
  log: PreflightLog = (msg, fields) => console.log(msg, fields ?? {}),
): Promise<void> {
  if (sandboxIdentity(source) !== null) assertImageLaneEntryExists()

  if (source.NODE_ENV !== "production") return

  if (process.getuid?.() === 0) {
    throw new Error(
      "media-worker: refusing to run as root. The image entrypoint drops to the unprivileged 'node' " +
        "user (keeping only ambient CAP_SETUID/CAP_SETGID so decoders can be spawned as the sandbox " +
        "uid); running as root would hand a decoder exploit the whole container.",
    )
  }

  const tools = await resolveMediaToolPaths(source)
  const identity = sandboxIdentity(source)
  if (identity === null) {
    throw new Error(
      "media-worker: MEDIA_SANDBOX_UID / MEDIA_SANDBOX_GID are required in production",
    )
  }

  await assertScratchHandover(identity)
  await assertImageLaneRuns()
  await assertVideoLaneRuns(tools.ffprobe)

  if (process.platform !== "linux") {
    log("media-worker: sandbox capability proof skipped (not Linux)", {
      platform: process.platform,
    })
    return
  }

  await assertUnprivilegedChild(identity)
  log("media-worker: sandbox preflight ok", {
    sandboxUid: identity.uid,
    sandboxGid: identity.gid,
    boundingSetDropped: dropBoundingSet(),
    ffmpeg: tools.ffmpeg,
    ffprobe: tools.ffprobe,
  })
}

function assertImageLaneEntryExists(): void {
  const entry = imageLaneEntry()
  if (existsSync(entry)) return
  throw new Error(
    `media-worker: the sandboxed image lane entry ${entry} does not exist. Point ` +
      "MEDIA_IMAGE_LANE_ENTRY at dist/image-lane.js (under tsx the default resolves next to " +
      "src/main.ts); without it every image upload would be rejected.",
  )
}

async function assertVideoLaneRuns(ffprobePath: string): Promise<void> {
  try {
    await runTool("preflight-ffprobe", ffprobePath, ["-hide_banner", "-version"], {
      timeoutMs: PREFLIGHT_TIMEOUT_MS,
      maxStdoutBytes: 64 * 1024,
    })
  } catch (err) {
    throw new Error(
      `media-worker: the sandboxed ffprobe cannot run (${String(err)}). Every video would be rejected.`,
    )
  }
}

async function assertImageLaneRuns(): Promise<void> {
  let result: Awaited<ReturnType<typeof processImageLane>>
  try {
    result = await processImageLane(ONE_PIXEL_PNG, loadLimits())
  } catch (err) {
    throw new Error(
      `media-worker: the sandboxed image lane cannot process a 1x1 PNG (${String(err)}). Every image ` +
        "upload would be rejected and its bytes deleted. Check MEDIA_IMAGE_LANE_ENTRY / " +
        "dist/image-lane.js and that the sandbox uid can read node_modules.",
    )
  }
  if (result.strippedBytes.byteLength === 0 || result.thumbnailBytes.byteLength === 0) {
    throw new Error("media-worker: the sandboxed image lane produced empty output for a 1x1 PNG")
  }
}

async function assertScratchHandover(identity: SandboxIdentity): Promise<void> {
  try {
    const scratch = await makeScratch(new Uint8Array([0]), "bin")
    await scratch.cleanup()
  } catch (err) {
    throw new Error(
      `media-worker: cannot hand a job scratch directory to gid ${identity.gid} (${String(err)}). ` +
        "The image must create the sandbox group and add `node` to it (usermod -aG mediatools node).",
    )
  }
}

async function assertUnprivilegedChild(identity: SandboxIdentity): Promise<void> {
  const readable = await access(STATUS_READER, constants.X_OK).then(
    () => true,
    () => false,
  )
  if (!readable) {
    throw new Error(
      `media-worker: ${STATUS_READER} is missing from the image, so the sandbox preflight cannot ` +
        "prove that decoders run without capabilities. Refusing to start.",
    )
  }

  let stdout: string
  try {
    const res = await runTool("sandbox-preflight", STATUS_READER, [PROC_STATUS], {
      timeoutMs: PREFLIGHT_TIMEOUT_MS,
      maxStdoutBytes: 64 * 1024,
      identity,
    })
    stdout = res.stdout
  } catch (err) {
    throw new Error(
      `media-worker: cannot spawn a sandboxed child as uid ${identity.uid}/gid ${identity.gid} ` +
        `(${String(err)}). The container needs cap_add SETUID,SETGID, an entrypoint that keeps them ` +
        "ambient (services/media-worker/docker-entrypoint.sh), setpriv from util-linux, and the uid " +
        "must exist in the image.",
    )
  }

  const failure = sandboxProofFailure(stdout, identity, {
    parentUid: process.getuid?.(),
    parentGid: process.getgid?.(),
    boundingMustBeZero: dropBoundingSet(),
  })
  if (failure !== null) {
    throw new Error(
      `media-worker: the decoder sandbox is not what it claims to be - ${failure}. A decoder that keeps ` +
        "CAP_SETUID can setuid() back to the worker's uid and read its environment (DATABASE_URL, the " +
        "R2 credentials). Refusing to start.",
    )
  }
}
