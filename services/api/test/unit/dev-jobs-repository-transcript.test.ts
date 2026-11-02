import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

// The pinned SQL of the developer console's jobs read (test/unit/sql-transcripts.test.ts), read from its
// snapshot: pg-boss 12 has no archive, so the read must name only pgboss_v12's tables.
const SNAPSHOTS = new URL("./__snapshots__/sql-transcripts.test.ts.snap", import.meta.url)

function pinnedTranscript(key: string): string {
  const text = readFileSync(SNAPSHOTS, "utf8")
  const start = text.indexOf(`exports[\`sql transcripts > ${key} 1\`]`)
  if (start < 0) throw new Error(`no transcript pinned for ${key}`)
  const end = text.indexOf("\n`;\n", start)
  return text.slice(start, end)
}

describe("developer jobs read transcript", () => {
  it("GH297-T20: the snapshot read names pgboss_v12.job and pgboss_v12.schedule and no archive", () => {
    const transcript = pinnedTranscript("makeDrizzleDevJobsRepository.snapshot")
    expect(transcript).toContain("pgboss_v12.job")
    expect(transcript).toContain("pgboss_v12.schedule")
    expect(transcript).not.toContain("archive")
  })
})
