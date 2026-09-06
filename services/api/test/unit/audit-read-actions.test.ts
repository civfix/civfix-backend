import { readFileSync, readdirSync, statSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { AUDIT_READ_ACTIONS } from "../../src/services/admin/audit.js"


const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "src")

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (full.endsWith(".ts")) out.push(full)
  }
  return out
}

function readAuditActions(): { action: string; file: string }[] {
  const found: { action: string; file: string }[] = []
  for (const file of walk(SRC)) {
    const source = readFileSync(file, "utf8")
    for (const call of source.matchAll(/auditRead\(([\s\S]{0,400}?)\n\s*\}\)/g)) {
      const action = /action:\s*"([a-z0-9_.]+)"/.exec(call[1] as string)
      if (action !== null) found.push({ action: action[1] as string, file })
    }
  }
  return found
}

describe("AUDIT_READ_ACTIONS covers every auditRead call site", () => {
  it("finds the read-audited routes at all (the scan is not vacuous)", () => {
    expect(readAuditActions().length).toBeGreaterThan(3)
  })

  it("lists every action written through auditRead, so none of them floods the activity feed", () => {
    const listed = new Set<string>(AUDIT_READ_ACTIONS)
    const missing = readAuditActions()
      .filter((entry) => !listed.has(entry.action))
      .map((entry) => `${entry.action} (${entry.file.slice(SRC.length + 1)})`)
    expect(
      [...new Set(missing)].sort(),
      "add these to AUDIT_READ_ACTIONS in src/services/admin/audit.ts",
    ).toEqual([])
  })
})
