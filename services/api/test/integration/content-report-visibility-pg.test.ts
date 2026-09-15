import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { randomUUID } from "node:crypto"
import { AppError } from "@civfix/shared"
import { withPg, type PgHarness, testHandle } from "../helpers/pg.js"
import { seedCleanup } from "../helpers/cleanups.js"
import {
  makeDrizzleContentSubjectGate,
  type ContentSubjectGate,
} from "../../src/services/content-report-subject.js"

const pg = await withPg()

const ABSENT = "00000000-0000-0000-0000-000000000000"

describe.skipIf(!pg)("content-report subject gate (integration: real visibility)", () => {
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

  async function seedReport(reporterId: string, status: string, visibility: string): Promise<string> {
    const [r] = await h.sql<{ id: string }[]>`
      INSERT INTO reports (
        reporter_user_id, idempotency_key, geom, geom_source, category, status, visibility, h3_cell
      )
      VALUES (
        ${reporterId}, gen_random_uuid(), ST_SetSRID(ST_MakePoint(-118.35, 34.1), 4326),
        'manual', 'trash', ${status}, ${visibility}, 'h0'
      )
      RETURNING id
    `
    return r!.id
  }

  async function seedPost(authorId: string, visibility: string): Promise<string> {
    const [p] = await h.sql<{ id: string }[]>`
      INSERT INTO posts (author_id, kind, body, visibility)
      VALUES (${authorId}, 'post', 'content', ${visibility}) RETURNING id
    `
    return p!.id
  }

  async function seedGroup(ownerId: string, visibility: string): Promise<string> {
    const [g] = await h.sql<{ id: string }[]>`
      INSERT INTO chat_groups (name, owner_id, visibility)
      VALUES ('Neighbors', ${ownerId}, ${visibility}) RETURNING id
    `
    return g!.id
  }

  async function seedGroupMessage(groupId: string, senderId: string): Promise<string> {
    const [m] = await h.sql<{ id: string }[]>`
      INSERT INTO chat_messages (group_id, sender_id, body, kind)
      VALUES (${groupId}, ${senderId}, 'hello', 'text') RETURNING id
    `
    return m!.id
  }

  async function addGroupMember(groupId: string, userId: string): Promise<void> {
    await h.sql`
      INSERT INTO chat_group_members (group_id, user_id) VALUES (${groupId}, ${userId})
    `
  }

  async function seedMedia(postId: string, status: string): Promise<string> {
    const id = randomUUID()
    await h.sql`
      INSERT INTO media_assets (id, upload_id, kind, r2_key, status, byte_size, purpose, post_id)
      VALUES (${id}, ${randomUUID()}, 'image', ${`k/${id}`}, ${status}, 1024, 'post', ${postId})
    `
    return id
  }

  const rejects404 = (p: Promise<void>) => expect(p).rejects.toMatchObject({ httpStatus: 404 })

  it("report: public report is reportable; held report is only reportable by its owner", async () => {
    const owner = await newUser("owner")
    const other = await newUser("other")
    const publicReport = await seedReport(owner, "published", "public")
    const heldReport = await seedReport(owner, "held", "public")

    await expect(gate.assertReportable("report", publicReport, other)).resolves.toBeUndefined()
    await expect(gate.assertReportable("report", heldReport, owner)).resolves.toBeUndefined()
    await rejects404(gate.assertReportable("report", heldReport, other))
    await rejects404(gate.assertReportable("report", ABSENT, other))
  })

  it("post: public post is reportable; a hidden post by someone else is not", async () => {
    const author = await newUser("author")
    const other = await newUser("viewer")
    const publicPost = await seedPost(author, "public")
    const hiddenPost = await seedPost(author, "hidden")

    await expect(gate.assertReportable("post", publicPost, other)).resolves.toBeUndefined()
    await rejects404(gate.assertReportable("post", hiddenPost, other))
    await rejects404(gate.assertReportable("post", ABSENT, other))
  })

  it("message: a private-group message is reportable only by a member (IDOR gate)", async () => {
    const owner = await newUser("group owner")
    const member = await newUser("group member")
    const outsider = await newUser("outsider")
    const group = await seedGroup(owner, "private")
    await addGroupMember(group, owner)
    await addGroupMember(group, member)
    const message = await seedGroupMessage(group, owner)

    await expect(gate.assertReportable("message", message, member)).resolves.toBeUndefined()
    await rejects404(gate.assertReportable("message", message, outsider))
    await rejects404(gate.assertReportable("message", ABSENT, member))
  })

  it("message: a DM is reportable by either participant and by nobody else", async () => {
    const a = await newUser("dm a")
    const b = await newUser("dm b")
    const outsider = await newUser("dm outsider")
    const [thread] = await h.sql<{ id: string }[]>`
      INSERT INTO dm_threads (user_lo, user_hi)
      VALUES (LEAST(${a}::uuid, ${b}::uuid), GREATEST(${a}::uuid, ${b}::uuid))
      RETURNING id
    `
    const [message] = await h.sql<{ id: string }[]>`
      INSERT INTO dm_messages (thread_id, sender_id, body, kind)
      VALUES (${thread!.id}, ${a}, 'hey', 'text')
      RETURNING id
    `

    await expect(gate.assertReportable("message", message!.id, b)).resolves.toBeUndefined()
    await expect(gate.assertReportable("message", message!.id, a)).resolves.toBeUndefined()
    await rejects404(gate.assertReportable("message", message!.id, outsider))
  })

  it("F052: a soft-deleted message stays reportable by a room member (hit-and-run abuse)", async () => {
    const owner = await newUser("hr owner")
    const member = await newUser("hr member")
    const outsider = await newUser("hr outsider")
    const group = await seedGroup(owner, "private")
    await addGroupMember(group, owner)
    await addGroupMember(group, member)
    const message = await seedGroupMessage(group, owner)
    await h.sql`UPDATE chat_messages SET deleted_at = now() WHERE id = ${message}`

    await expect(gate.assertReportable("message", message, member)).resolves.toBeUndefined()
    await rejects404(gate.assertReportable("message", message, outsider))
  })

  it("profile: an existing user is reportable; an unknown id is not", async () => {
    const target = await newUser("target")
    const reporter = await newUser("reporter")

    await expect(gate.assertReportable("profile", target, reporter)).resolves.toBeUndefined()
    await rejects404(gate.assertReportable("profile", ABSENT, reporter))
  })

  it("event: an existing cleanup is reportable; an unknown id is not", async () => {
    const organizer = await newUser("organizer")
    const cleanupId = await seedCleanup(h.sql, {
      organizerUserId: organizer,
      title: "Cleanup",
    })
    const reporter = await newUser("event reporter")

    await expect(gate.assertReportable("event", cleanupId, reporter)).resolves.toBeUndefined()
    await rejects404(gate.assertReportable("event", ABSENT, reporter))
  })

  it("photo: media on a public post is reportable; an unknown id is not", async () => {
    const author = await newUser("photo author")
    const other = await newUser("photo viewer")
    const post = await seedPost(author, "public")
    const media = await seedMedia(post, "ready")

    await expect(gate.assertReportable("photo", media, other)).resolves.toBeUndefined()
    await rejects404(gate.assertReportable("photo", ABSENT, other))
  })

  it("photo: media on a hidden post is not reportable by a non-author, and non-ready media is never reportable", async () => {
    const author = await newUser("hidden photo author")
    const other = await newUser("hidden photo viewer")
    const hiddenPost = await seedPost(author, "hidden")
    const mediaOnHidden = await seedMedia(hiddenPost, "ready")
    const publicPost = await seedPost(author, "public")
    const validatingMedia = await seedMedia(publicPost, "validating")

    await rejects404(gate.assertReportable("photo", mediaOnHidden, other))
    await expect(gate.assertReportable("photo", mediaOnHidden, author)).resolves.toBeUndefined()
    await rejects404(gate.assertReportable("photo", validatingMedia, other))
  })

  it("comment: the discussion system was removed, so no comment is reportable", async () => {
    const reporter = await newUser("comment reporter")
    await rejects404(gate.assertReportable("comment", randomUUID(), reporter))
  })

  it("rejections are AppError not-found instances", async () => {
    const reporter = await newUser("err reporter")
    await expect(gate.assertReportable("post", ABSENT, reporter)).rejects.toBeInstanceOf(AppError)
  })
})
