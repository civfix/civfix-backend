import { describe, expect, it } from "vitest"
import postgres from "postgres"
import {
  MEDIA_BINDING_RELATIONS,
  mediaBoundElsewhere,
  mediaBoundToCleanup,
} from "../../src/services/media-bindings.js"
import { orphanPredicate } from "../../src/services/media-worker-repo.js"

const sql = postgres("postgres://user:pass@127.0.0.1:1/unused", { max: 1 })

interface RenderableFragment {
  strings: readonly string[]
  args: readonly unknown[]
}

function isFragment(value: unknown): value is RenderableFragment {
  return (
    typeof value === "object" &&
    value !== null &&
    Array.isArray((value as { strings?: unknown }).strings)
  )
}

function render(fragment: unknown): string {
  if (!isFragment(fragment)) return "$param"
  return fragment.strings
    .map((part, index) => part + (index < fragment.args.length ? render(fragment.args[index]) : ""))
    .join("")
}

const CLEANUP_ID = "00000000-0000-4000-8000-000000000001"

describe("media binding predicate", () => {
  it("covers every relation that binds a media asset", () => {
    const text = render(mediaBoundElsewhere(sql, null))
    for (const relation of MEDIA_BINDING_RELATIONS) {
      const [table, column] = relation.split(".")
      expect(text, `${relation} is not in the shared bound predicate`).toContain(table as string)
      expect(text, `${relation} is not in the shared bound predicate`).toContain(column as string)
    }
  })

  it("exempts every one of those relations from the orphan sweep", () => {
    const text = render(orphanPredicate(sql, new Date()))
    expect(text).toContain("NOT (")
    for (const relation of MEDIA_BINDING_RELATIONS) {
      const [table, column] = relation.split(".")
      expect(
        text,
        `${relation} is not exempted; a bound asset older than the TTL would be reaped`,
      ).toContain(table as string)
      expect(text).toContain(column as string)
    }
    expect(text).toContain("media_assets.report_id IS NULL")
    expect(text).toContain("media_assets.chat_message_id IS NULL")
    expect(text).toContain("media_assets.post_id IS NULL")
    expect(text).toContain("media_assets.purpose <> 'verification'")
  })

  it("keeps the event's own bindings claimable while excluding every other owner's", () => {
    const elsewhere = render(mediaBoundElsewhere(sql, CLEANUP_ID))
    expect(elsewhere).toContain("oc.id <>")
    expect(elsewhere).toContain("pm.cleanup_id <>")

    const own = render(mediaBoundToCleanup(sql, CLEANUP_ID))
    expect(own).toContain("cur.cover_media_id = media_assets.id")
    expect(own).toContain("cur.gallery_media_ids @> ARRAY[media_assets.id]")
    expect(own).toContain("pm.media_id = media_assets.id")
  })
})
