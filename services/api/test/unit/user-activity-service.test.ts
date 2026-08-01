import { describe, it, expect } from "vitest"
import {
  makeUserActivityService,
  type UserActivityRecord,
  type UserActivityRepository,
} from "../../src/services/user-activity-service.js"

const TARGET = "11111111-1111-1111-1111-111111111111"
const VIEWER = "22222222-2222-2222-2222-222222222222"

function repoWith(records: UserActivityRecord[]): UserActivityRepository {
  return {
    listActivity: () => Promise.resolve(records),
  }
}

const oneRecord: UserActivityRecord = {
  id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
  kind: "created_report",
  at: new Date("2026-01-01T00:00:00.000Z"),
  title: "Pothole",
  subtitle: null,
  refKind: "report",
  refId: "rep-1",
}

function serviceWith(edges: Array<{ blocker: string; blocked: string }>) {
  return makeUserActivityService({
    repo: repoWith([oneRecord]),
    blockState: (viewerId, targetId) =>
      Promise.resolve({
        blockedByViewer: edges.some((e) => e.blocker === viewerId && e.blocked === targetId),
        blockedByTarget: edges.some((e) => e.blocker === targetId && e.blocked === viewerId),
      }),
  })
}

describe("user-activity block gate (CVX-023)", () => {
  it("404s with the profile's message when the target blocked the viewer", async () => {
    const service = serviceWith([{ blocker: TARGET, blocked: VIEWER }])
    await expect(service.list(TARGET, VIEWER, null, 25)).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "Person not found",
    })
  })

  it("returns an empty page when the viewer blocked the target", async () => {
    const service = serviceWith([{ blocker: VIEWER, blocked: TARGET }])
    expect(await service.list(TARGET, VIEWER, null, 25)).toEqual({ items: [], nextCursor: null })
  })

  it("prefers the empty page over the 404 when both directions are blocked", async () => {
    const service = serviceWith([
      { blocker: VIEWER, blocked: TARGET },
      { blocker: TARGET, blocked: VIEWER },
    ])
    expect(await service.list(TARGET, VIEWER, null, 25)).toEqual({ items: [], nextCursor: null })
  })

  it("returns activity normally when not blocked", async () => {
    const service = serviceWith([])
    const res = await service.list(TARGET, VIEWER, null, 25)
    expect(res.items.map((i) => i.id)).toEqual([oneRecord.id])
  })

  it("does not consult the block gate for an anonymous viewer", async () => {
    let consulted = false
    const service = makeUserActivityService({
      repo: repoWith([oneRecord]),
      blockState: () => {
        consulted = true
        return Promise.resolve({ blockedByViewer: true, blockedByTarget: true })
      },
    })
    const res = await service.list(TARGET, null, null, 25)
    expect(consulted).toBe(false)
    expect(res.items).toHaveLength(1)
  })

  it("does not consult the block gate for the owner's own activity", async () => {
    let consulted = false
    const service = makeUserActivityService({
      repo: repoWith([oneRecord]),
      blockState: () => {
        consulted = true
        return Promise.resolve({ blockedByViewer: true, blockedByTarget: true })
      },
    })
    const res = await service.list(TARGET, TARGET, null, 25)
    expect(consulted).toBe(false)
    expect(res.items).toHaveLength(1)
  })

  it("returns activity when no block gate is wired at all", async () => {
    const service = makeUserActivityService({ repo: repoWith([oneRecord]) })
    const res = await service.list(TARGET, VIEWER, null, 25)
    expect(res.items).toHaveLength(1)
  })
})
