import { readFileSync } from "node:fs"
import { parseBool } from "@civfix/api/env-parsers"
import { MS_PER_MINUTE } from "@civfix/api/time"

export type FilerLog = (line: string, fields?: Record<string, unknown>) => void

export const consoleLog: FilerLog = (line, fields) => console.log(line, fields ?? {})

/** D2's org contact block: every filing is made as CivFix, never as the resident. */
export interface FilingContact {
  firstName: string
  lastName: string
  email: string
  phone: string | null
}

export interface FilerConfig {
  workspaceDir: string
  /** FILER_DRY_RUN (D10): every live run is a dry run and ends needs_human / dry_run. */
  dryRun: boolean
  contact: FilingContact
  /** The `filer` group every run entry belongs to; null where the group does not exist (tests). */
  filerGid: number | null
  scriptTimeoutMs: number
}

export const WORKSPACE_DIR = "/workspace"
export const FILER_GROUP = "filer"
const SCRIPT_TIMEOUT_MS = 5 * MS_PER_MINUTE

/** An id from /etc/passwd or /etc/group; null when the name is not there. */
function lookupId(file: "/etc/passwd" | "/etc/group", name: string): number | null {
  let text: string
  try {
    text = readFileSync(file, "utf8")
  } catch {
    return null
  }
  for (const line of text.split("\n")) {
    const [entry, , id] = line.split(":")
    if (entry === name && id !== undefined && /^\d+$/.test(id)) return Number(id)
  }
  return null
}

export function lookupUid(name: string): number | null {
  return lookupId("/etc/passwd", name)
}

export function lookupGid(name: string): number | null {
  return lookupId("/etc/group", name)
}

export function required(source: NodeJS.ProcessEnv, key: string): string {
  const value = (source[key] ?? "").trim()
  if (value === "") throw new Error(`city-filer: ${key} is required`)
  return value
}

export function loadConfig(source: NodeJS.ProcessEnv = process.env): FilerConfig {
  const filerGid = lookupGid(FILER_GROUP)
  if (filerGid === null && source.NODE_ENV === "production") {
    throw new Error(`city-filer: the image's "${FILER_GROUP}" group is missing`)
  }
  return {
    workspaceDir: WORKSPACE_DIR,
    dryRun: parseBool(source.FILER_DRY_RUN, false),
    contact: {
      firstName: required(source, "FILING_CONTACT_FIRST_NAME"),
      lastName: required(source, "FILING_CONTACT_LAST_NAME"),
      email: required(source, "FILING_CONTACT_EMAIL"),
      phone: (source.FILING_CONTACT_PHONE ?? "").trim() || null,
    },
    filerGid,
    scriptTimeoutMs: SCRIPT_TIMEOUT_MS,
  }
}
