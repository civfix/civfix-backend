/**
 * The event status derivation, pinned on BOTH sides of the seam (DECISIONS §40).
 *
 * `cleanupStatusExpr` (SQL, projected into every select that feeds a DTO's `status`) and
 * `deriveCleanupStatus` (TS, from @civfix/shared/host, used by every in-memory repository twin) must
 * answer the same question the same way. A divergence between them is invisible to CI otherwise: the
 * unit suite exercises the fakes and only the Docker-gated suite exercises the SQL. So this file
 * asserts the SQL text encodes exactly the branch order the TS helper implements, then walks both
 * through the same boundary table.
 *
 * It also guards the two rules that came with the derivation: the `when` list filters range-scan
 * `ends_at`, and no day-math `AT TIME ZONE` under src/services falls back to a `'UTC'` literal.
 */

import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { deriveCleanupStatus } from "@civfix/shared/host"
import type { Sql } from "../../src/db/client.js"
import {
  adminEventStatusExpr,
  buildWhenFilter,
  cleanupStatusExpr,
} from "../../src/services/cleanup-sql.js"
import { InMemoryCleanupRepository } from "../helpers/cleanups.js"

/** A postgres.js-shaped tag that renders the template back to text, params inlined as `${…}`. */
function textSql(): Sql {
  const tag = (strings: TemplateStringsArray, ...values: unknown[]): string =>
    strings.reduce<string>(
      (out, chunk, i) => out + chunk + (i < values.length ? String(values[i]) : ""),
      "",
    )
  return tag as unknown as Sql
}

const NOW = Date.parse("2026-06-01T12:00:00.000Z")
const HOUR = 3_600_000

describe("cleanupStatusExpr (the SQL half)", () => {
  const text = cleanupStatusExpr(textSql()) as unknown as string

  it("consults the stored column for 'cancelled' and nothing else", () => {
    expect(text.match(/c\.status/g)).toHaveLength(1)
    expect(text).toContain("WHEN c.status = 'cancelled' THEN 'cancelled'")
  })

  it("orders the branches cancelled -> done -> active -> upcoming", () => {
    expect(text.indexOf("'cancelled'")).toBeLessThan(text.indexOf("'done'"))
    expect(text.indexOf("'done'")).toBeLessThan(text.indexOf("'active'"))
    expect(text.indexOf("'active'")).toBeLessThan(text.indexOf("ELSE 'upcoming'"))
  })

  it("uses the inclusive left edge on both boundaries, against transaction time", () => {
    expect(text).toContain("WHEN c.ends_at <= now() THEN 'done'")
    expect(text).toContain("WHEN c.scheduled_at <= now() THEN 'active'")
  })
})

describe("adminEventStatusExpr", () => {
  const text = adminEventStatusExpr(textSql()) as unknown as string

  it("is the same derivation with the admin wire names", () => {
    expect(text).toContain("WHEN c.status = 'cancelled' THEN 'cancelled'")
    expect(text).toContain("WHEN c.ends_at <= now() THEN 'completed'")
    expect(text).toContain("WHEN c.scheduled_at <= now() THEN 'in_progress'")
    expect(text).toContain("ELSE 'upcoming'")
  })
})

describe("buildWhenFilter", () => {
  const render = (when: "upcoming" | "past" | "attending" | undefined): string =>
    buildWhenFilter(textSql(), when) as unknown as string

  it("keeps an underway event in upcoming: the predicate is ends_at, not scheduled_at", () => {
    for (const when of ["upcoming", "attending"] as const) {
      const text = render(when)
      expect(text).toContain("c.status <> 'cancelled'")
      expect(text).toContain("c.ends_at > now()")
      expect(text).not.toContain("scheduled_at")
    }
  })

  it("past is the exact complement, still excluding cancelled", () => {
    const text = render("past")
    expect(text).toContain("c.status <> 'cancelled'")
    expect(text).toContain("c.ends_at <= now()")
  })

  it("an absent when filters only cancelled", () => {
    expect(render(undefined)).toContain("c.status <> 'cancelled'")
    expect(render(undefined)).not.toContain("ends_at")
  })
})

describe("deriveCleanupStatus (the TS twin the memory repositories use)", () => {
  const window = (startOffsetH: number, endOffsetH: number, cancelled = false) => ({
    status: (cancelled ? "cancelled" : "upcoming") as "cancelled" | "upcoming",
    scheduledAt: new Date(NOW + startOffsetH * HOUR).toISOString(),
    endsAt: new Date(NOW + endOffsetH * HOUR).toISOString(),
  })

  it.each([
    ["before the start", window(1, 5), "upcoming"],
    ["exactly at the start", window(0, 4), "active"],
    ["mid-event", window(-1, 3), "active"],
    ["exactly at the end", window(-4, 0), "done"],
    ["after the end", window(-8, -4), "done"],
  ] as const)("%s -> %s", (_label, w, expected) => {
    expect(deriveCleanupStatus(w, NOW)).toBe(expected)
  })

  it("cancelled wins over every clock reading", () => {
    expect(deriveCleanupStatus(window(1, 5, true), NOW)).toBe("cancelled")
    expect(deriveCleanupStatus(window(-8, -4, true), NOW)).toBe("cancelled")
  })

  it("ignores a legacy stored 'done' entirely", () => {
    expect(
      deriveCleanupStatus(
        {
          status: "done",
          scheduledAt: new Date(NOW + HOUR).toISOString(),
          endsAt: new Date(NOW + 5 * HOUR).toISOString(),
        },
        NOW,
      ),
    ).toBe("upcoming")
  })
})

describe("the in-memory cleanup repository mirrors the projection", () => {
  it("reports active / done from the window while the column still says upcoming", async () => {
    const repo = new InMemoryCleanupRepository()
    repo.now = () => new Date(NOW)
    const organizerUserId = "11111111-1111-1111-1111-111111111111"
    repo.seedUser({ id: organizerUserId, displayName: "Olive" })

    const underway = repo.seedCleanup({
      organizerUserId,
      scheduledAt: new Date(NOW - HOUR),
      endsAt: new Date(NOW + 3 * HOUR),
    })
    const past = repo.seedCleanup({
      organizerUserId,
      scheduledAt: new Date(NOW - 8 * HOUR),
      endsAt: new Date(NOW - 4 * HOUR),
    })

    expect(underway.status).toBe("upcoming")
    expect(past.status).toBe("upcoming")
    expect((await repo.findCleanupById(underway.id, null))?.status).toBe("active")
    expect((await repo.findCleanupById(past.id, null))?.status).toBe("done")
  })
})

describe("day math never falls back to a 'UTC' literal", () => {
  const servicesDir = fileURLToPath(new URL("../../src/services/", import.meta.url))

  function tsFilesUnder(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) return tsFilesUnder(full)
      return entry.isFile() && entry.name.endsWith(".ts") ? [full] : []
    })
  }

  it("every AT TIME ZONE under src/services takes a zone, except the ISO-instant renderers", () => {
    const offenders: string[] = []
    for (const file of tsFilesUnder(servicesDir)) {
      readFileSync(file, "utf8")
        .split("\n")
        .forEach((line, i) => {
          if (!line.includes("AT TIME ZONE 'UTC'")) return
          // `to_char(x AT TIME ZONE 'UTC', '...Z"')` renders an ISO-8601 instant; UTC is the point.
          if (line.includes("to_char(") && line.includes('Z"')) return
          offenders.push(`${file.slice(servicesDir.length)}:${i + 1}`)
        })
    }
    expect(offenders).toEqual([])
  })
})
