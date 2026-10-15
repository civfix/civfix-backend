import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { randomUUID } from "node:crypto"
import { withPg, testHandle, type PgHarness } from "../helpers/pg.js"
import { seedCleanup } from "../helpers/cleanups.js"
import {
  makeDrizzleContentSubjectGate,
  type ContentSubjectGate,
} from "../../src/services/content-report-subject.js"

const pg = await withPg()

const NOT_FOUND = { httpStatus: 404, message: "Content not found" }

describe.skipIf(!pg)("content-report subject gate (integration: event visibility)", () => {
  let h: PgHarness
  let gate: ContentSubjectGate

  beforeAll(() => {
    h = pg as PgHarness
    gate = makeDrizzleContentSubjectGate(h.sql, h.db)
  })

  afterAll(async () => {
    await h.teardown()
  })

  async function newUser(name: string): Promise<string> {
    const [u] = await h.sql<{ id: string }[]>`
      INSERT INTO users (display_name, handle) VALUES (${name}, ${testHandle()}) RETURNING id
    `
    return u!.id
  }

  async function seedEvent(visibility: string, organizationId?: string): Promise<string> {
    const organizer = await newUser("organizer")
    const id = await seedCleanup(h.sql, {
      organizerUserId: organizer,
      ...(organizationId !== undefined ? { organizationId } : {}),
    })
    await h.sql`UPDATE cleanups SET visibility = ${visibility} WHERE id = ${id}`
    return id
  }

  it("hides a private event from a non-member and admits its members", async () => {
    const eventId = await seedEvent("private")
    const outsider = await newUser("outsider")
    const attendee = await newUser("attendee")
    await h.sql`
      INSERT INTO cleanup_members (cleanup_id, user_id, role) VALUES (${eventId}, ${attendee}, 'member')
    `

    await expect(gate.assertReportable("event", eventId, outsider)).rejects.toMatchObject(NOT_FOUND)
    await expect(gate.assertReportable("event", randomUUID(), outsider)).rejects.toMatchObject(
      NOT_FOUND,
    )
    await expect(gate.assertReportable("event", eventId, attendee)).resolves.toBeUndefined()
  })

  it("admits a member of the hosting organization, but not once the organization is deleted", async () => {
    const slug = `org-${randomUUID().slice(0, 8)}`
    const [org] = await h.sql<{ id: string }[]>`
      INSERT INTO organizations (slug, name) VALUES (${slug}, ${slug}) RETURNING id
    `
    const eventId = await seedEvent("private", org!.id)
    const orgMember = await newUser("org member")
    await h.sql`
      INSERT INTO organization_members (organization_id, user_id, role)
      VALUES (${org!.id}, ${orgMember}, 'member')
    `

    await expect(gate.assertReportable("event", eventId, orgMember)).resolves.toBeUndefined()

    await h.sql`UPDATE organizations SET deleted_at = now() WHERE id = ${org!.id}`
    await expect(gate.assertReportable("event", eventId, orgMember)).rejects.toMatchObject(
      NOT_FOUND,
    )
  })

  it("keeps public, unlisted and cancelled public events reportable by anyone signed in", async () => {
    const reporter = await newUser("reporter")
    const publicEvent = await seedEvent("public")
    const unlistedEvent = await seedEvent("unlisted")
    const cancelledEvent = await seedEvent("public")
    await h.sql`UPDATE cleanups SET status = 'cancelled' WHERE id = ${cancelledEvent}`

    for (const eventId of [publicEvent, unlistedEvent, cancelledEvent]) {
      await expect(gate.assertReportable("event", eventId, reporter)).resolves.toBeUndefined()
    }
  })
})
