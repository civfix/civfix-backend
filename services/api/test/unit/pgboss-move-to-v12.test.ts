import { describe, expect, it } from "vitest"
import { runPgBossMove, type PgBossMoveResult } from "../../src/db/pgboss-move-to-v12.js"

async function run(argv: string[], result: PgBossMoveResult) {
  const applies: boolean[] = []
  const lines: string[] = []
  await runPgBossMove(
    argv,
    ({ apply }) => {
      applies.push(apply)
      return Promise.resolve(result)
    },
    (line) => lines.push(line),
  )
  return { applies, lines }
}

const MOVED: PgBossMoveResult = {
  oldSchema: true,
  queues: [
    { name: "media.checks", moved: 2, skippedExisting: 1, skippedNoQueue: 0 },
    { name: "retired.queue", moved: 0, skippedExisting: 0, skippedNoQueue: 3 },
  ],
}

describe("pgboss-move-to-v12 command line", () => {
  it("T32: a dry run without --apply, a move with it, one line per queue", async () => {
    const dry = await run([], MOVED)
    expect(dry.applies).toEqual([false])
    expect(dry.lines[0]).toMatch(/dry run/)

    const applied = await run(["--apply"], MOVED)
    expect(applied.applies).toEqual([true])
    expect(applied.lines[0]).not.toMatch(/dry run/)

    for (const { lines } of [dry, applied]) {
      expect(lines.slice(1)).toEqual([
        "media.checks: moved 2, skipped (already in pgboss_v12) 1, skipped (no queue in pgboss_v12) 0",
        "retired.queue: moved 0, skipped (already in pgboss_v12) 0, skipped (no queue in pgboss_v12) 3",
      ])
    }
  })

  it("T30: says there is no old schema and finishes", async () => {
    for (const argv of [[], ["--apply"]]) {
      const { lines } = await run(argv, { oldSchema: false, queues: [] })
      expect(lines).toHaveLength(2)
      expect(lines[1]).toMatch(/no old pgboss schema/)
    }
  })
})
