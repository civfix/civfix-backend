import { beforeEach, describe, expect, it } from "vitest"
import type { Sql } from "../../src/db/client.js"
import {
  drainTable,
  registerRetentionLane,
  registeredRetentionLanes,
  resetRetentionLanesForTests,
  runRetentionLanes,
} from "../../src/services/host/retention-lanes.js"
import { registerHostRetentionLanes } from "../../src/services/host/comms-jobs.js"

const SQL = {} as Sql

describe("retention lane registry", () => {
  beforeEach(() => {
    resetRetentionLanesForTests()
  })

  it("registers a lane once, ignoring a duplicate name", () => {
    registerRetentionLane("a", () => Promise.resolve(1))
    registerRetentionLane("a", () => Promise.resolve(2))
    expect(registeredRetentionLanes()).toHaveLength(1)
  })

  it("runs every lane and reports what each processed", async () => {
    registerRetentionLane("a", () => Promise.resolve(3))
    registerRetentionLane("b", () => Promise.resolve(5))
    expect(await runRetentionLanes(SQL, new Date())).toEqual([
      { lane: "a", processed: 3 },
      { lane: "b", processed: 5 },
    ])
  })

  it("keeps running the other lanes when one throws", async () => {
    registerRetentionLane("a", () => Promise.reject(new Error("boom")))
    registerRetentionLane("b", () => Promise.resolve(7))
    const results = await runRetentionLanes(SQL, new Date())
    expect(results).toEqual([
      { lane: "a", processed: 0 },
      { lane: "b", processed: 7 },
    ])
  })

  it("passes one shared clock to every lane", async () => {
    const seen: number[] = []
    registerRetentionLane("a", (_sql, now) => {
      seen.push(now.getTime())
      return Promise.resolve(0)
    })
    registerRetentionLane("b", (_sql, now) => {
      seen.push(now.getTime())
      return Promise.resolve(0)
    })
    await runRetentionLanes(SQL, new Date(1000))
    expect(seen).toEqual([1000, 1000])
  })
})

describe("the lanes the host jobs register", () => {
  beforeEach(() => {
    resetRetentionLanesForTests()
  })

  it("registers the registration lanes alongside the comms lanes", () => {
    registerHostRetentionLanes()
    expect(registeredRetentionLanes().map((lane) => lane.name)).toEqual([
      "broadcast_deliveries",
      "broadcast_content",
      "host_exports",
      "registrations",
    ])
  })
})

describe("drainTable", () => {
  it("stops on the first short page", async () => {
    const pages = [10, 10, 4]
    let i = 0
    const total = await drainTable(() => Promise.resolve(pages[i++] ?? 0), 10, 50)
    expect(total).toBe(24)
    expect(i).toBe(3)
  })

  it("stops at the page ceiling rather than looping forever", async () => {
    let calls = 0
    const total = await drainTable(
      () => {
        calls += 1
        return Promise.resolve(10)
      },
      10,
      3,
    )
    expect(calls).toBe(3)
    expect(total).toBe(30)
  })
})
