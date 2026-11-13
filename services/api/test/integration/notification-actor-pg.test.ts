/**
 * GH#308 slice 2: GET /notifications says who each notification is about. Every case drives the real
 * Fastify app on PostGIS with the container's own wiring, so the actor is recorded by the production
 * writers (follow, post activity, chat mention) and read back by the production list. Storage is the
 * seams fake, so an avatar key presigns to https://fake-storage.invalid/<key>.
 */

import { readFile } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { FastifyInstance, LightMyRequestResponse } from "fastify"
import type { NotificationDTO, UserProfileDTO } from "@civfix/contract"
import { TEST_TICKET_SIGNER } from "../helpers/ticket-signer.js"
import { withPg, type PgHarness, testHandle } from "../helpers/pg.js"
import { seedAvatarUsers } from "../helpers/avatar-fixtures.js"
import { makeServer } from "../../src/server.js"
import { makeContainer, type Container } from "../../src/di.js"
import { loadEnv } from "../../src/env.js"
import { InMemoryCacheClient } from "../../src/auth/cache.js"
import { PgAuthStores } from "../../src/auth/pg-stores.js"
import { makeAuthServices, type AuthServices } from "../../src/auth/auth-services.js"
import { makeDrizzleChatRepository } from "../../src/services/chat-repository.drizzle.js"
import { makeDrizzleCleanupRepository } from "../../src/services/cleanup-repository.drizzle.js"
import { makeCleanupService } from "../../src/services/cleanup-service.js"
import { makeReportChatRepository } from "../../src/services/report-chat-repository.drizzle.js"
import { makeChatGroupRepository } from "../../src/services/chat-group-repository.drizzle.js"
import { makeConversationMutesRepository } from "../../src/services/conversation-mutes-repository.drizzle.js"
import { makeDrizzleBlocksRepository } from "../../src/services/blocks-repository.drizzle.js"
import { makeChatMentionNotifier } from "../../src/services/chat-bells.js"
import { notifyReporterOfStatus } from "../../src/services/admin/report-status-notifier.js"
import { fakeAvatarPresigner } from "../helpers/avatar-fixtures.js"
import { roomKeyFor } from "../../src/ws/gateway.js"

const pg = await withPg()

const MIGRATION = new URL("../../drizzle/0232_notifications_actor.sql", import.meta.url)

interface Session {
  cookie: string
  csrfToken: string
}

interface Person {
  id: string
  name: string
  handle: string
  session: Session
}

describe.skipIf(!pg)("notification actor on GET /notifications (integration)", () => {
  let h: PgHarness
  let app: FastifyInstance
  let container: Container
  let authServices: AuthServices

  beforeAll(async () => {
    h = pg as PgHarness
    const env = loadEnv({ NODE_ENV: "test", DATABASE_URL: h.uri })
    container = makeContainer(env)
    authServices = makeAuthServices({
      stores: new PgAuthStores(container.getDb().db, {
        certificateObjects: container.storage,
        notifier: container.getNotificationService(),
        jobs: container.jobs,
      }),
      cache: new InMemoryCacheClient(),
      mailer: container.mailer,
      oauthConfig: {},
    })
    app = await makeServer({ env, container, authServices })
  })

  afterAll(async () => {
    await app?.close()
    await h.teardown()
  })

  async function signIn(userId: string): Promise<Session> {
    const token = await authServices.sessions.createSession(userId, ["citizen"])
    const csrfToken = await container.csrf.tokenForSession(token)
    return { cookie: `civfix_session=${token}`, csrfToken }
  }

  async function person(label: string): Promise<Person> {
    const name = `${label} ${randomUUID().slice(0, 6)}`
    const handle = testHandle()
    const [u] = await h.sql<{ id: string }[]>`
      INSERT INTO users (display_name, handle) VALUES (${name}, ${handle}) RETURNING id
    `
    return { id: u!.id, name, handle, session: await signIn(u!.id) }
  }

  function send(
    s: Session,
    method: "POST" | "DELETE",
    url: string,
    payload?: object,
  ): Promise<LightMyRequestResponse> {
    return app.inject({
      method,
      url,
      headers: { cookie: s.cookie, "x-csrf-token": s.csrfToken },
      ...(payload !== undefined ? { payload } : {}),
    })
  }

  async function ok(res: Promise<LightMyRequestResponse>): Promise<void> {
    const r = await res
    expect(r.statusCode, r.body).toBeLessThan(300)
  }

  const follow = (by: Person, whom: Person) =>
    ok(send(by.session, "POST", `/v1/people/${whom.id}/follow`))
  const block = (by: Person, whom: Person) =>
    ok(send(by.session, "POST", `/v1/users/${whom.id}/block`))

  async function list(viewer: Person): Promise<NotificationDTO[]> {
    const res = await app.inject({
      method: "GET",
      url: "/v1/notifications?limit=50",
      headers: { cookie: viewer.session.cookie },
    })
    expect(res.statusCode, res.body).toBe(200)
    return res.json<{ items: NotificationDTO[] }>().items
  }

  async function only(viewer: Person, type: NotificationDTO["type"]): Promise<NotificationDTO> {
    const items = (await list(viewer)).filter((n) => n.type === type)
    expect(items, `${type} items`).toHaveLength(1)
    return items[0]!
  }

  async function postBy(author: Person, body: string): Promise<string> {
    const [row] = await h.sql<{ id: string }[]>`
      INSERT INTO posts (author_id, kind, body) VALUES (${author.id}, 'post', ${body}) RETURNING id
    `
    return row!.id
  }

  /** T1's given: B follows A, A does not follow B. */
  async function followedBy(): Promise<{ a: Person; b: Person }> {
    const a = await person("Alma")
    const b = await person("Benito")
    await follow(b, a)
    return { a, b }
  }

  it("T1: a new follower's item names them, and isFollowing is false while A does not follow back", async () => {
    const { a, b } = await followedBy()
    const item = await only(a, "new_follower")
    expect(item.actor).toMatchObject({
      id: b.id,
      name: b.name,
      handle: b.handle,
      isFollowing: false,
    })
  })

  it("T2: once A follows B back, the same item's actor.isFollowing is true", async () => {
    const { a, b } = await followedBy()
    const before = await only(a, "new_follower")
    await follow(a, b)
    const after = await only(a, "new_follower")
    expect(after.id).toBe(before.id)
    expect(after.actor?.isFollowing).toBe(true)
  })

  it("T3: like, repost, reply, quote and mention each name the person who acted", async () => {
    const a = await person("Alma")
    const c = await person("Carmen")
    const postId = await postBy(a, "A's post")
    await ok(send(c.session, "POST", `/v1/posts/${postId}/like`))
    await ok(send(c.session, "POST", `/v1/posts/${postId}/repost`))
    await ok(
      send(c.session, "POST", "/v1/posts", { kind: "reply", body: "a reply", replyToId: postId }),
    )
    await ok(
      send(c.session, "POST", "/v1/posts", { kind: "quote", body: "a quote", repostOfId: postId }),
    )
    await ok(send(c.session, "POST", "/v1/posts", { body: "hi there", mentionedUserIds: [a.id] }))

    const items = await list(a)
    for (const type of [
      "post_like",
      "post_repost",
      "post_reply",
      "post_quote",
      "post_mention",
    ] as const) {
      const item = items.find((n) => n.type === type)
      expect(item, type).toBeDefined()
      expect(item!.actor?.id, type).toBe(c.id)
    }
  })

  it("T4: a mention in a cleanup chat names the message author", async () => {
    const a = await person("Alma")
    const d = await person("Dario")
    const cleanups = makeCleanupService({
      tickets: TEST_TICKET_SIGNER,
      repo: makeDrizzleCleanupRepository(h.sql),
    })
    const cleanup = await cleanups.createCleanup(
      {
        title: "Actor sweep",
        type: "site",
        eventKind: "cleanup",
        lat: 34.05,
        lng: -118.25,
        scheduledAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
        slots: [{ title: "General volunteers", capacity: null }],
      },
      a.id,
    )
    await cleanups.joinCleanup(cleanup.id, d.id)
    const message = await makeDrizzleChatRepository(h.sql).insertMessage(
      { cleanupId: cleanup.id, userId: d.id, body: `@${a.handle} see you there` },
      randomUUID(),
    )
    const cleanupRepo = makeDrizzleCleanupRepository(h.sql)
    const reportChatRepo = makeReportChatRepository(h.sql)
    const groups = makeChatGroupRepository(h.sql)
    const mutes = makeConversationMutesRepository(h.sql)
    const blocks = makeDrizzleBlocksRepository(h.sql, fakeAvatarPresigner)
    await makeChatMentionNotifier({
      notificationService: container.getNotificationService(),
      isMutedFor: (userId, kind, roomId) => mutes.isMuted(userId, kind, roomId),
      isCleanupMember: (cleanupId, userId) => cleanupRepo.isMember(cleanupId, userId),
      isReportChatMember: (reportId, userId) => reportChatRepo.isMember(reportId, userId),
      isChatGroupMember: async (groupId, userId) => (await groups.roleOf(groupId, userId)) !== null,
      isBlockedEitherWay: (x, y) => blocks.isBlockedEitherWay(x, y),
      roomKeyFor,
    })({
      kind: "cleanup",
      roomId: cleanup.id,
      actorUserId: d.id,
      mentionedUserId: a.id,
      message,
    })

    const item = await only(a, "chat_mention")
    expect(item.actor?.id).toBe(d.id)
  })

  it("T5: a report update has no actor", async () => {
    const a = await person("Alma")
    const [report] = await h.sql<{ id: string }[]>`
      INSERT INTO reports (idempotency_key, geom, geom_source, category, type, status, h3_cell, reporter_user_id)
      VALUES (${randomUUID()}, ST_SetSRID(ST_MakePoint(-118.35, 34.1), 4326), 'manual', 'trash', 'dump', 'resolved', 'h0', ${a.id})
      RETURNING id
    `
    await notifyReporterOfStatus(
      { notifications: container.getNotificationService() },
      report!.id,
      a.id,
      "resolved",
    )
    const item = await only(a, "report_update")
    expect(item.actor).toBeNull()
  })

  it("T6: after A blocks B, B's follow item is still listed with its title, and actor is null", async () => {
    const { a, b } = await followedBy()
    const before = await only(a, "new_follower")
    await block(a, b)
    const after = await only(a, "new_follower")
    expect(after.id).toBe(before.id)
    expect(after.title).toBe(before.title)
    expect(after.actor).toBeNull()
  })

  it("T7: after B blocks A, B's follow item is still listed with its title, and actor is null", async () => {
    const { a, b } = await followedBy()
    const before = await only(a, "new_follower")
    await block(b, a)
    const after = await only(a, "new_follower")
    expect(after.id).toBe(before.id)
    expect(after.title).toBe(before.title)
    expect(after.actor).toBeNull()
  })

  it("T8: after B deletes their account, the item's actor is null", async () => {
    const { a, b } = await followedBy()
    await ok(send(b.session, "DELETE", "/v1/me", { emailOtp: "000000" }))
    const item = await only(a, "new_follower")
    expect(item.actor).toBeNull()
  })

  it("T9: a row stored without an actor is listed with actor null and its fields as stored", async () => {
    const a = await person("Alma")
    const [row] = await h.sql<{ id: string; created_at: Date }[]>`
      INSERT INTO notifications (user_id, type, title, body, link)
      VALUES (${a.id}, 'new_follower', 'New follower', 'Someone started following you.', '/people/x')
      RETURNING id, created_at
    `
    expect(await list(a)).toEqual([
      {
        id: row!.id,
        type: "new_follower",
        title: "New follower",
        body: "Someone started following you.",
        link: "/people/x",
        read: false,
        createdAt: row!.created_at.toISOString(),
        actor: null,
      },
    ])
  })

  it("T10: a like, unlike and like again inside the dedupe window is one item naming the liker", async () => {
    const a = await person("Alma")
    const b = await person("Benito")
    const postId = await postBy(a, "A's post")
    await ok(send(b.session, "POST", `/v1/posts/${postId}/like`))
    await ok(send(b.session, "DELETE", `/v1/posts/${postId}/like`))
    await ok(send(b.session, "POST", `/v1/posts/${postId}/like`))
    const item = await only(a, "post_like")
    expect(item.actor?.id).toBe(b.id)
  })

  it("T11: the actor's avatarUrl is the one B's profile serves A", async () => {
    const seeded = await seedAvatarUsers(h.sql)
    const a = await person("Alma")
    const b: Person = {
      id: seeded.P.id,
      name: seeded.P.displayName,
      handle: seeded.P.handle,
      session: await signIn(seeded.P.id),
    }
    await follow(b, a)
    const profile = await app.inject({
      method: "GET",
      url: `/v1/people/${b.id}`,
      headers: { cookie: a.session.cookie },
    })
    expect(profile.statusCode, profile.body).toBe(200)
    const served = profile.json<{ profile: UserProfileDTO }>().profile.avatarUrl
    expect(served).toBeTruthy()
    const item = await only(a, "new_follower")
    expect(item.actor?.avatarUrl).toBe(served)
  })

  it("T12: the migration applies twice on a database with notifications, leaving them actor-less", async () => {
    const ddl = await readFile(MIGRATION, "utf8")
    await h.sql`ALTER TABLE notifications DROP COLUMN IF EXISTS actor_id`
    const a = await person("Alma")
    const [row] = await h.sql<{ id: string }[]>`
      INSERT INTO notifications (user_id, type, title) VALUES (${a.id}, 'new_follower', 'New follower')
      RETURNING id
    `
    await h.sql.begin((tx) => tx.unsafe(ddl))
    await h.sql.begin((tx) => tx.unsafe(ddl))
    const rows = await h.sql<{ actor_id: string | null }[]>`
      SELECT actor_id FROM notifications WHERE id = ${row!.id}
    `
    expect(rows).toEqual([{ actor_id: null }])
  })
})
