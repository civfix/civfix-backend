// GH#224 / D1: the category each notification path is gated by, read from what the path asked for
// (`input.category ?? categoryForType(input.type)`) or, for the service's own social hooks, from the
// row they stored.

import { describe, expect, it, vi } from "vitest"
import { getTableColumns } from "drizzle-orm"
import { drizzle } from "drizzle-orm/postgres-js"
import * as schema from "../../src/db/schema/index.js"
import { PgUserStore } from "../../src/auth/pg-stores.js"
import { notifyHoursCredited } from "../../src/services/volunteer-hours-service.js"
import { categoryForType } from "../../src/services/notification-categories.js"
import { captureNotifications, categoryOfInput } from "../helpers/notification-capture.js"

const ERASED = "77777777-7777-4777-8777-777777777777"
const COHOST = "88888888-8888-4888-8888-888888888888"
const EVENT = "99999999-9999-4999-8999-999999999999"
const B = "bbbbbbbb-0000-4000-8000-000000000002"

// The host transfer reads its rows through SQL this harness cannot answer, so the erasure repository
// hands back one moved event and the rest of the erasure runs on a stand-in client.
vi.mock("../../src/services/erasure-repository.drizzle.js", () => ({
  makeDrizzleErasureRepository: () => ({
    transferHostedEvents: () =>
      Promise.resolve([{ cleanup_id: EVENT, new_organizer: COHOST, title: "Creek sweep" }]),
    releaseOrganizations: () => Promise.resolve(),
    scrubAttendeeContributions: () => Promise.resolve([]),
    scrubModerationSnapshots: () => Promise.resolve(),
    purgeVerificationDocuments: () => Promise.resolve([]),
  }),
}))

function erasureDb() {
  const tombstone = Object.keys(getTableColumns(schema.users)).map((key) =>
    key === "id" ? ERASED : null,
  )
  const client = {
    options: { parsers: {}, serializers: {} },
    unsafe(query: string) {
      const result = Promise.resolve([]) as Promise<unknown[]> & { values(): Promise<unknown> }
      result.values = () => Promise.resolve(/^update "users"/i.test(query) ? [tombstone] : [])
      return result
    },
    begin<T>(callback: (tx: unknown) => Promise<T>): Promise<T> {
      return callback(client)
    },
  }
  return drizzle(client as never, { schema })
}

const post = { recipientId: B, actorName: "Ana", postId: "p1" }

describe("per-path category", () => {
  it("T48: a post mention, reply and quote are Mentions and replies", async () => {
    const n = captureNotifications()
    await n.service.onPostMention(post)
    await n.service.onPostReply(post)
    await n.service.onPostQuote(post)
    expect(n.rows(B).map((r) => categoryForType(r.type))).toEqual([
      "mentions",
      "mentions",
      "mentions",
    ])
  })

  it("T51: an erasure host transfer and logged hours are Event team and hours", async () => {
    const n = captureNotifications()
    await new PgUserStore(erasureDb(), { notifier: n.service }).softDeleteAndAnonymize(ERASED)
    await notifyHoursCredited({ notifier: n.service }, [{ userId: B, hours: 2 }], {
      titleKey: "notification.hours_logged.title",
      bodyKey: "notification.hours_logged.body",
      vars: { title: "Creek sweep" },
      link: `/cleanups/${EVENT}`,
      logContext: {},
    })
    expect(n.inputs.map((c) => [c.input.type, categoryOfInput(c.input)])).toEqual([
      ["cleanup_role", "eventTeam"],
      ["hours_logged", "eventTeam"],
    ])
  })

  it("T52: a new follower is New followers", async () => {
    const n = captureNotifications()
    await n.service.onNewFollower({
      followeeId: B,
      follower: { id: COHOST, displayName: "Ana", handle: "ana" } as never,
    })
    expect(n.rows(B).map((r) => categoryForType(r.type))).toEqual(["followers"])
  })

  it("T53: a post like and repost are Likes and reposts", async () => {
    const n = captureNotifications()
    await n.service.onPostLike(post)
    await n.service.onPostRepost(post)
    expect(n.rows(B).map((r) => categoryForType(r.type))).toEqual([
      "likesAndReposts",
      "likesAndReposts",
    ])
  })
})
