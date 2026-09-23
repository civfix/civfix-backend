import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { randomUUID } from "node:crypto"
import { withPg, testHandle, type PgHarness } from "../helpers/pg.js"
import { seedMediaAsset, type SeededMedia } from "../helpers/media-pg.js"
import { attachChatMedia } from "../../src/services/chat-attachments.drizzle.js"
import { userUploader } from "../../src/services/media-uploader.js"
import {
  makeDrizzlePostRepository,
  type PostRepository,
} from "../../src/services/post-repository.drizzle.js"

const pg = await withPg()

const UNAVAILABLE = "One or more media uploads are unavailable."

describe.skipIf(!pg)("post and chat media claims (integration: only unbound fresh uploads)", () => {
  let h: PgHarness
  let posts: PostRepository
  let attackerId: string

  beforeAll(async () => {
    h = pg as PgHarness
    posts = makeDrizzlePostRepository(h.sql, {
      presignMedia: (r2Key) => Promise.resolve({ url: `memory://${r2Key}` }),
      presignAvatar: (r2Key) => Promise.resolve(`memory://${r2Key}`),
    })
    attackerId = await newUser("attacker")
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

  async function victimAvatar(): Promise<SeededMedia> {
    const victim = await newUser("avatar victim")
    const media = await seedMediaAsset(h.sql)
    await h.sql`UPDATE users SET avatar_media_id = ${media.id} WHERE id = ${victim}`
    return media
  }

  async function orgLogo(): Promise<SeededMedia> {
    const media = await seedMediaAsset(h.sql, { purpose: "org_logo" })
    const slug = `org-${randomUUID().slice(0, 8)}`
    await h.sql`
      INSERT INTO organizations (slug, name, logo_media_id) VALUES (${slug}, ${slug}, ${media.id})
    `
    return media
  }

  function createPost(uploadId: string) {
    return posts.createPost({
      authorId: attackerId,
      kind: "post",
      body: "look",
      replyToId: null,
      repostOfId: null,
      eventId: null,
      reportId: null,
      mediaUploadIds: [uploadId],
      mentionedUserIds: [],
      organizationId: null,
    })
  }

  async function mediaRow(id: string) {
    const [row] = await h.sql<
      { post_id: string | null; chat_message_id: string | null; purpose: string }[]
    >`SELECT post_id, chat_message_id, purpose FROM media_assets WHERE id = ${id}`
    return row!
  }

  it("a post refuses another user's avatar and leaves its purpose alone", async () => {
    const media = await victimAvatar()

    await expect(createPost(media.uploadId)).rejects.toMatchObject({
      httpStatus: 422,
      fields: { mediaUploadIds: UNAVAILABLE },
    })
    expect(await mediaRow(media.id)).toEqual({
      post_id: null,
      chat_message_id: null,
      purpose: "report",
    })
  })

  it("a post refuses an organization logo and a verification document", async () => {
    const logo = await orgLogo()
    const document = await seedMediaAsset(h.sql, { purpose: "verification" })

    await expect(createPost(logo.uploadId)).rejects.toMatchObject({ httpStatus: 422 })
    await expect(createPost(document.uploadId)).rejects.toMatchObject({ httpStatus: 422 })
    expect((await mediaRow(logo.id)).purpose).toBe("org_logo")
    expect((await mediaRow(document.id)).purpose).toBe("verification")
  })

  it("a post refuses another user's replaced avatar that nothing binds any more", async () => {
    const victim = await newUser("avatar replacer")
    const replaced = await seedMediaAsset(h.sql, { uploader: userUploader(victim) })

    await expect(createPost(replaced.uploadId)).rejects.toMatchObject({
      httpStatus: 422,
      fields: { mediaUploadIds: UNAVAILABLE },
    })
    expect((await mediaRow(replaced.id)).post_id).toBeNull()
  })

  it("a post still claims the author's own fresh upload", async () => {
    const media = await seedMediaAsset(h.sql, { uploader: userUploader(attackerId) })

    const postId = await createPost(media.uploadId)

    expect(await mediaRow(media.id)).toEqual({
      post_id: postId,
      chat_message_id: null,
      purpose: "post",
    })
  })

  it("a chat message leaves another user's avatar and an organization logo unbound", async () => {
    const avatar = await victimAvatar()
    const logo = await orgLogo()

    await expect(
      attachChatMedia(
        h.sql,
        randomUUID(),
        [avatar.uploadId, logo.uploadId],
        new Date(),
        attackerId,
      ),
    ).rejects.toMatchObject({ httpStatus: 422, fields: { mediaUploadIds: UNAVAILABLE } })

    expect((await mediaRow(avatar.id)).chat_message_id).toBeNull()
    expect((await mediaRow(logo.id)).chat_message_id).toBeNull()
  })

  it("a chat message refuses an erased user's upload", async () => {
    const erased = await newUser("erased user")
    const media = await seedMediaAsset(h.sql, { uploader: userUploader(erased) })
    await h.sql`UPDATE users SET deleted_at = now() WHERE id = ${erased}`

    await expect(
      attachChatMedia(h.sql, randomUUID(), [media.uploadId], new Date(), attackerId),
    ).rejects.toMatchObject({ httpStatus: 422, fields: { mediaUploadIds: UNAVAILABLE } })
    expect((await mediaRow(media.id)).chat_message_id).toBeNull()
  })

  it("a chat message still claims the sender's own fresh upload, and re-claims it idempotently", async () => {
    const media = await seedMediaAsset(h.sql, { uploader: userUploader(attackerId) })
    const messageId = randomUUID()
    const sentAt = new Date()

    await attachChatMedia(h.sql, messageId, [media.uploadId], sentAt, attackerId)
    await attachChatMedia(h.sql, messageId, [media.uploadId], sentAt, attackerId)

    expect((await mediaRow(media.id)).chat_message_id).toBe(messageId)
  })
})
