/**
 * GH#209, second slice: chat, events, orgs, the leaderboard and admin show the one resolved avatar URL (the
 * ready avatar media's thumbnail, else its served copy, else the stored avatar_url), and saving a profile
 * photo no longer writes users.avatar_url. Runs through the real Fastify app on PostGIS. Storage is the
 * seams fake, so keys presign to memory://<key>. The users P, S, V, R, O and N are the shared fixtures in
 * test/helpers/avatar-fixtures.ts; every case seeds its own set.
 */

import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { FastifyInstance, LightMyRequestResponse } from "fastify"
import type { Role } from "@civfix/contract"
import { withPg, type PgHarness } from "../helpers/pg.js"
import { seedCleanup } from "../helpers/cleanups.js"
import { seedMediaAsset } from "../helpers/media-pg.js"
import { makeServer } from "../../src/server.js"
import { makeContainer, type Container } from "../../src/di.js"
import { loadEnv } from "../../src/env.js"
import { InMemoryCacheClient } from "../../src/auth/cache.js"
import { InMemoryCounterStore } from "../../src/abuse/counter-store.js"
import { PgAuthStores } from "../../src/auth/pg-stores.js"
import { makeAuthServices, type AuthServices } from "../../src/auth/auth-services.js"
import { WsChatService } from "../../src/adapters/chat-service.ws.js"
import { InMemoryChatPubSub } from "../../src/adapters/chat-pubsub.js"
import { makeDrizzleChatRepository } from "../../src/services/chat-repository.drizzle.js"
import { makeDrizzleMediaWorkerRepository } from "../../src/services/media-worker-repository.drizzle.js"
import { makePrivateMediaPresigner } from "../../src/services/media-presign.js"
import { userUploader } from "../../src/services/media-uploader.js"
import { avatarPresigner } from "../../src/services/user-avatar.js"
import { LA_CITY } from "../../src/db/seed-fixtures.js"
import { seedAvatarUsers, type SeededAvatarUser } from "../helpers/avatar-fixtures.js"

const pg = await withPg()

const OPERATOR_EMAIL = "avatar-operator@civfix.test"

// One allowlisted address per admin exchange case: every case seeds fresh users, and users.email is unique.
const EXCHANGE_EMAILS = {
  T21: "avatar-exchange-t21@civfix.test",
  T22: "avatar-exchange-t22@civfix.test",
  T23: "avatar-exchange-t23@civfix.test",
  T24: "avatar-exchange-t24@civfix.test",
  T25: "avatar-exchange-t25@civfix.test",
} as const

const DAY_MS = 86_400_000

interface Session {
  cookie: string
  csrfToken: string
}

interface WithAvatar {
  id?: string
  avatarUrl?: string | null
}

describe.skipIf(!pg)("user avatar URLs on chat, event, org and admin routes (integration)", () => {
  let h: PgHarness
  let app: FastifyInstance
  let container: Container
  let authServices: AuthServices

  beforeAll(async () => {
    h = pg as PgHarness
    const env = loadEnv({
      NODE_ENV: "test",
      DATABASE_URL: h.uri,
      ADMIN_EMAILS: [OPERATOR_EMAIL, ...Object.values(EXCHANGE_EMAILS)].join(","),
      R2_PUBLIC_BASE: "cdn.civfix.org",
    })
    container = makeContainer(env)
    // The test env has no Redis: the cache, the counters and the chat fan-out run in memory, and the event
    // chat reads the real repository the way the container wires it outside fake-chat mode.
    const cache = new InMemoryCacheClient()
    const counters = new InMemoryCounterStore()
    Object.assign(container, {
      getCache: () => cache,
      getCounterStore: () => counters,
      chatService: new WsChatService({
        repo: makeDrizzleChatRepository(
          h.sql,
          makePrivateMediaPresigner(container.storage),
          avatarPresigner(container.storage),
        ),
        pubsub: new InMemoryChatPubSub(),
      }),
    })
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

  async function signIn(
    user: SeededAvatarUser | { id: string },
    role: Role = "citizen",
  ): Promise<Session> {
    const token = await authServices.sessions.createSession(user.id, [role])
    const csrfToken = await container.csrf.tokenForSession(token)
    return { cookie: `civfix_session=${token}`, csrfToken }
  }

  async function getJson<T>(s: Session | null, url: string): Promise<T> {
    const res = await app.inject({
      method: "GET",
      url,
      headers: s === null ? {} : { cookie: s.cookie },
    })
    return okJson<T>(res)
  }

  async function sendJson<T>(
    s: Session,
    method: "POST" | "PUT",
    url: string,
    payload: object,
  ): Promise<T> {
    const res = await app.inject({
      method,
      url,
      headers: { cookie: s.cookie, "x-csrf-token": s.csrfToken },
      payload,
    })
    return okJson<T>(res)
  }

  function okJson<T>(res: LightMyRequestResponse): T {
    expect(res.statusCode, res.body).toBe(200)
    return res.json<T>()
  }

  function avatarOf(list: readonly WithAvatar[], user: SeededAvatarUser): WithAvatar["avatarUrl"] {
    const found = list.find((p) => p.id === user.id)
    expect(found, `${user.displayName} is listed`).toBeDefined()
    return found!.avatarUrl
  }

  async function storedAvatarOf(
    user: SeededAvatarUser,
  ): Promise<{ avatar_url: string | null; avatar_media_id: string | null }> {
    const [row] = await h.sql<{ avatar_url: string | null; avatar_media_id: string | null }[]>`
      SELECT avatar_url, avatar_media_id FROM users WHERE id = ${user.id}
    `
    return row!
  }

  async function joinEvent(
    cleanupId: string,
    user: SeededAvatarUser,
    role = "member",
  ): Promise<void> {
    await h.sql`
      INSERT INTO cleanup_members (cleanup_id, user_id, role) VALUES (${cleanupId}, ${user.id}, ${role})
    `
  }

  async function hostedEvent(
    host: SeededAvatarUser,
    opts: { scheduledAt?: Date; endsAt?: Date; lng?: number; lat?: number } = {},
  ): Promise<string> {
    const id = await seedCleanup(h.sql, { organizerUserId: host.id, ...opts })
    await joinEvent(id, host, "organizer")
    return id
  }

  async function postEventMessage(cleanupId: string, sender: SeededAvatarUser): Promise<string> {
    const [row] = await h.sql<{ id: string }[]>`
      INSERT INTO chat_messages (cleanup_id, sender_id, body, kind)
      VALUES (${cleanupId}, ${sender.id}, ${`from ${sender.displayName}`}, 'text')
      RETURNING id
    `
    return row!.id
  }

  async function dmThread(a: SeededAvatarUser, b: SeededAvatarUser): Promise<string> {
    const [lo, hi] = a.id < b.id ? [a.id, b.id] : [b.id, a.id]
    const [row] = await h.sql<{ id: string }[]>`
      INSERT INTO dm_threads (user_lo, user_hi) VALUES (${lo}, ${hi}) RETURNING id
    `
    return row!.id
  }

  async function organization(owner: SeededAvatarUser): Promise<string> {
    const slug = `org-${randomUUID().slice(0, 8)}`
    const [org] = await h.sql<{ id: string }[]>`
      INSERT INTO organizations (slug, name) VALUES (${slug}, ${`Org ${slug}`}) RETURNING id
    `
    await h.sql`
      INSERT INTO organization_members (organization_id, user_id, role, joined_at)
      VALUES (${org!.id}, ${owner.id}, 'owner', now())
    `
    return org!.id
  }

  type Message = { id: string; from: WithAvatar }

  it("T1: GET /cleanups/:id/messages shows P's thumbnail, S's served copy and O's stored URL", async () => {
    const u = await seedAvatarUsers(h.sql)
    const cleanupId = await hostedEvent(u.N)
    const sent: Partial<Record<"P" | "S" | "O", string>> = {}
    for (const name of ["P", "S", "O"] as const) {
      await joinEvent(cleanupId, u[name])
      sent[name] = await postEventMessage(cleanupId, u[name])
    }
    const page = await getJson<{ items: Message[] }>(
      await signIn(u.N),
      `/v1/cleanups/${cleanupId}/messages`,
    )
    const avatars: Partial<Record<"P" | "S" | "O", WithAvatar["avatarUrl"]>> = {}
    for (const name of ["P", "S", "O"] as const) {
      const message = page.items.find((m) => m.id === sent[name])
      expect(message, `${name}'s message is in the history`).toBeDefined()
      avatars[name] = message!.from.avatarUrl
    }
    expect(avatars).toEqual({
      P: "memory://thumbs/uploads/2026/10/p1.jpg",
      S: "memory://processed/uploads/2026/10/s1",
      O: "https://lh3.googleusercontent.com/a/o",
    })
  })

  it("T2: GET /dm/:id/messages shows P's messages to N with P's thumbnail URL", async () => {
    const u = await seedAvatarUsers(h.sql)
    const threadId = await dmThread(u.P, u.N)
    await h.sql`
      INSERT INTO dm_messages (thread_id, sender_id, body, kind)
      VALUES (${threadId}, ${u.P.id}, 'hello from P', 'text'), (${threadId}, ${u.P.id}, 'again', 'text')
    `
    const page = await getJson<{ items: Message[] }>(
      await signIn(u.N),
      `/v1/dm/${threadId}/messages`,
    )
    const fromP = page.items.filter((m) => m.from.id === u.P.id)
    expect(fromP).toHaveLength(2)
    expect(fromP.map((m) => m.from.avatarUrl)).toEqual([
      "memory://thumbs/uploads/2026/10/p1.jpg",
      "memory://thumbs/uploads/2026/10/p1.jpg",
    ])
  })

  it("T3: GET /threads shows N's DM peer P with the thumbnail URL", async () => {
    const u = await seedAvatarUsers(h.sql)
    const threadId = await dmThread(u.P, u.N)
    const page = await getJson<{ items: Array<{ id: string; peer?: WithAvatar }> }>(
      await signIn(u.N),
      "/v1/threads?limit=50",
    )
    const thread = page.items.find((t) => t.id === threadId)
    expect(thread, "the DM is listed").toBeDefined()
    expect(thread!.peer?.avatarUrl).toBe("memory://thumbs/uploads/2026/10/p1.jpg")
  })

  it("T4: POST /dm answers N with peer P's thumbnail URL", async () => {
    const u = await seedAvatarUsers(h.sql)
    const body = await sendJson<{ thread: { peer?: WithAvatar } }>(
      await signIn(u.N),
      "POST",
      "/v1/dm",
      { userId: u.P.id },
    )
    expect(body.thread.peer?.avatarUrl).toBe("memory://thumbs/uploads/2026/10/p1.jpg")
  })

  it("T5: GET /groups/:id/members lists P with the thumbnail and V with the stored URL", async () => {
    const u = await seedAvatarUsers(h.sql)
    const [group] = await h.sql<{ id: string }[]>`
      INSERT INTO chat_groups (name, owner_id, kind, visibility)
      VALUES ('Avatar group', ${u.P.id}, 'group', 'private')
      RETURNING id
    `
    await h.sql`
      INSERT INTO chat_group_members (group_id, user_id, role)
      VALUES (${group!.id}, ${u.P.id}, 'owner'), (${group!.id}, ${u.V.id}, 'member')
    `
    const body = await getJson<{ members: Array<{ user: WithAvatar }> }>(
      await signIn(u.P),
      `/v1/groups/${group!.id}/members`,
    )
    const users = body.members.map((m) => m.user)
    expect({ P: avatarOf(users, u.P), V: avatarOf(users, u.V) }).toEqual({
      P: "memory://thumbs/uploads/2026/10/p1.jpg",
      V: "https://lh3.googleusercontent.com/a/v-old",
    })
  })

  it("T6: GET /cleanups/:id and GET /cleanups show organizer P with the thumbnail URL", async () => {
    const u = await seedAvatarUsers(h.sql)
    const lng = -118.2 + Math.random() / 100
    const lat = 34.05 + Math.random() / 100
    const cleanupId = await hostedEvent(u.P, { lng, lat })
    const session = await signIn(u.N)
    const detail = await getJson<{ organizer: WithAvatar }>(session, `/v1/cleanups/${cleanupId}`)
    const bbox = encodeURIComponent(
      JSON.stringify({
        west: lng - 0.001,
        south: lat - 0.001,
        east: lng + 0.001,
        north: lat + 0.001,
      }),
    )
    const list = await getJson<{ items: Array<{ id: string; organizer: WithAvatar }> }>(
      session,
      `/v1/cleanups?when=upcoming&bbox=${bbox}`,
    )
    const listed = list.items.find((c) => c.id === cleanupId)
    expect(listed, "the event is listed").toBeDefined()
    expect({ detail: detail.organizer.avatarUrl, list: listed!.organizer.avatarUrl }).toEqual({
      detail: "memory://thumbs/uploads/2026/10/p1.jpg",
      list: "memory://thumbs/uploads/2026/10/p1.jpg",
    })
  })

  it("GET /people/:id/events and a post sharing P's event show organizer P with the thumbnail URL", async () => {
    const u = await seedAvatarUsers(h.sql)
    const cleanupId = await hostedEvent(u.P, {
      scheduledAt: new Date(Date.now() - 3 * DAY_MS),
      endsAt: new Date(Date.now() - 2 * DAY_MS),
    })
    const [post] = await h.sql<{ id: string }[]>`
      INSERT INTO posts (author_id, kind, body, event_id)
      VALUES (${u.N.id}, 'post', 'join us', ${cleanupId})
      RETURNING id
    `
    const session = await signIn(u.N)
    const events = await getJson<{ items: Array<{ id: string; organizer: WithAvatar }> }>(
      session,
      `/v1/people/${u.P.id}/events`,
    )
    const shared = await getJson<{ event: { organizer: WithAvatar } | null }>(
      session,
      `/v1/posts/${post!.id}`,
    )
    expect({
      events: events.items.find((c) => c.id === cleanupId)?.organizer.avatarUrl,
      post: shared.event?.organizer.avatarUrl,
    }).toEqual({
      events: "memory://thumbs/uploads/2026/10/p1.jpg",
      post: "memory://thumbs/uploads/2026/10/p1.jpg",
    })
  })

  it("T7: GET /cleanups/:id/attendees shows P with the thumbnail and S with the served copy", async () => {
    const u = await seedAvatarUsers(h.sql)
    const cleanupId = await hostedEvent(u.N)
    await joinEvent(cleanupId, u.P)
    await joinEvent(cleanupId, u.S)
    const body = await getJson<{ attendees: WithAvatar[] }>(
      await signIn(u.N),
      `/v1/cleanups/${cleanupId}/attendees`,
    )
    expect({ P: avatarOf(body.attendees, u.P), S: avatarOf(body.attendees, u.S) }).toEqual({
      P: "memory://thumbs/uploads/2026/10/p1.jpg",
      S: "memory://processed/uploads/2026/10/s1",
    })
  })

  it("T8: GET /cleanups/:id/attendees hides the photo of an attendee P the viewer blocked", async () => {
    const u = await seedAvatarUsers(h.sql)
    const cleanupId = await hostedEvent(u.N)
    await joinEvent(cleanupId, u.P)
    await h.sql`INSERT INTO user_blocks (blocker_id, blocked_id) VALUES (${u.N.id}, ${u.P.id})`
    const body = await getJson<{ attendees: WithAvatar[] }>(
      await signIn(u.N),
      `/v1/cleanups/${cleanupId}/attendees`,
    )
    const attendee = body.attendees.find((a) => a.id === u.P.id)
    expect(attendee, "P is listed").toBeDefined()
    // The view's avatarUrl is null and the DTO leaves a null avatarUrl out, as on main.
    expect(attendee).not.toHaveProperty("avatarUrl")
  })

  it("T9: GET /cleanups/:id/registrations shows the host P's registration with the thumbnail URL", async () => {
    const u = await seedAvatarUsers(h.sql)
    const cleanupId = await hostedEvent(u.N)
    const [registration] = await h.sql<{ id: string }[]>`
      INSERT INTO cleanup_registrations (cleanup_id, user_id, party_size, status, source)
      VALUES (${cleanupId}, ${u.P.id}, 1, 'registered', 'self')
      RETURNING id
    `
    const body = await getJson<{ items: Array<{ id: string; person: WithAvatar | null }> }>(
      await signIn(u.N),
      `/v1/cleanups/${cleanupId}/registrations`,
    )
    const row = body.items.find((r) => r.id === registration!.id)
    expect(row, "P's registration is listed").toBeDefined()
    expect(row!.person?.avatarUrl).toBe("memory://thumbs/uploads/2026/10/p1.jpg")
  })

  it("T10: GET /cleanups/:id/team shows team member P with the thumbnail URL", async () => {
    const u = await seedAvatarUsers(h.sql)
    const cleanupId = await hostedEvent(u.N)
    await joinEvent(cleanupId, u.P, "cohost")
    const body = await getJson<{ members: Array<{ person: WithAvatar }> }>(
      await signIn(u.N),
      `/v1/cleanups/${cleanupId}/team`,
    )
    const people = body.members.map((m) => m.person)
    expect(avatarOf(people, u.P)).toBe("memory://thumbs/uploads/2026/10/p1.jpg")
  })

  it("T11: GET /cleanups/:id/announcements shows P's own announcement with P's thumbnail URL", async () => {
    const u = await seedAvatarUsers(h.sql)
    const cleanupId = await hostedEvent(u.P)
    await h.sql`
      INSERT INTO broadcasts (cleanup_id, created_by, kind, status, subject, body_md)
      VALUES (${cleanupId}, ${u.P.id}, 'announcement', 'sent', 'Bring gloves', 'See you there')
    `
    const body = await getJson<{ items: Array<{ author: WithAvatar | null }> }>(
      await signIn(u.N),
      `/v1/cleanups/${cleanupId}/announcements`,
    )
    expect(body.items).toHaveLength(1)
    expect(body.items[0]!.author?.avatarUrl).toBe("memory://thumbs/uploads/2026/10/p1.jpg")
  })

  it("T12: GET /cleanups/:id/insights lists top volunteer P with the thumbnail URL", async () => {
    const u = await seedAvatarUsers(h.sql)
    const cleanupId = await hostedEvent(u.N, {
      scheduledAt: new Date(Date.now() - 3 * DAY_MS),
      endsAt: new Date(Date.now() - 2 * DAY_MS),
    })
    await joinEvent(cleanupId, u.P)
    await h.sql`
      INSERT INTO volunteer_hours (user_id, cleanup_id, source, hours, logged_by_user_id)
      VALUES (${u.P.id}, ${cleanupId}, 'event', 4, ${u.N.id})
    `
    const body = await getJson<{ topVolunteers: Array<{ userId: string; avatarUrl?: string }> }>(
      await signIn(u.N),
      `/v1/cleanups/${cleanupId}/insights`,
    )
    const top = body.topVolunteers.find((v) => v.userId === u.P.id)
    expect(top, "P is a top volunteer").toBeDefined()
    expect(top!.avatarUrl).toBe("memory://thumbs/uploads/2026/10/p1.jpg")
  })

  it("T13: GET /orgs/:id/members lists member P with the thumbnail URL", async () => {
    const u = await seedAvatarUsers(h.sql)
    const orgId = await organization(u.N)
    await h.sql`
      INSERT INTO organization_members (organization_id, user_id, role, joined_at)
      VALUES (${orgId}, ${u.P.id}, 'member', now())
    `
    const body = await getJson<{ items: Array<{ person: WithAvatar }> }>(
      await signIn(u.N),
      `/v1/orgs/${orgId}/members`,
    )
    const people = body.items.map((m) => m.person)
    expect(avatarOf(people, u.P)).toBe("memory://thumbs/uploads/2026/10/p1.jpg")
  })

  it("T14: GET /orgs/:id/invites shows S invited by P, each with their resolved URL", async () => {
    const u = await seedAvatarUsers(h.sql)
    const orgId = await organization(u.P)
    // Accepted, because a pending invite names no account (DECISIONS §32).
    await h.sql`
      INSERT INTO organization_invites (
        organization_id, email, user_id, role, token_hash, status, invited_by, expires_at
      )
      VALUES (
        ${orgId}, ${u.S.email}, ${u.S.id}, 'member', ${randomUUID()}, 'accepted', ${u.P.id},
        ${new Date(Date.now() + DAY_MS)}
      )
    `
    const body = await getJson<{
      items: Array<{ user: WithAvatar | null; invitedBy: WithAvatar | null }>
    }>(await signIn(u.P), `/v1/orgs/${orgId}/invites`)
    expect(body.items).toHaveLength(1)
    expect({
      user: body.items[0]!.user?.avatarUrl,
      invitedBy: body.items[0]!.invitedBy?.avatarUrl,
    }).toEqual({
      user: "memory://processed/uploads/2026/10/s1",
      invitedBy: "memory://thumbs/uploads/2026/10/p1.jpg",
    })
  })

  it("T15: GET /jurisdictions/:geoid/leaderboard ranks P with the thumbnail URL", async () => {
    const u = await seedAvatarUsers(h.sql)
    await h.sql`
      INSERT INTO user_jurisdiction_hours (user_id, jurisdiction_geoid, total_hours)
      VALUES (${u.P.id}, ${LA_CITY.geoid}, 100000)
    `
    const body = await getJson<{ entries: Array<{ userId: string; avatarUrl?: string }> }>(
      null,
      `/v1/jurisdictions/${LA_CITY.geoid}/leaderboard`,
    )
    const entry = body.entries.find((e) => e.userId === u.P.id)
    expect(entry, "P is on the board").toBeDefined()
    expect(entry!.avatarUrl).toBe("memory://thumbs/uploads/2026/10/p1.jpg")
  })

  it("T16: GET /admin/users and GET /admin/users/:id show P with the thumbnail URL", async () => {
    const u = await seedAvatarUsers(h.sql)
    const [operator] = await h.sql<{ id: string }[]>`
      INSERT INTO users (display_name, handle, email, email_verified, role)
      VALUES ('Avatar Operator', ${`op${randomUUID().replace(/-/g, "").slice(0, 12)}`},
              ${OPERATOR_EMAIL}, true, 'operator')
      RETURNING id
    `
    const session = await signIn(operator!, "operator")
    const list = await getJson<{ items: WithAvatar[] }>(
      session,
      `/v1/admin/users?q=${encodeURIComponent(u.P.handle)}`,
    )
    const detail = await getJson<WithAvatar>(session, `/v1/admin/users/${u.P.id}`)
    expect({ list: avatarOf(list.items, u.P), detail: detail.avatarUrl }).toEqual({
      list: "memory://thumbs/uploads/2026/10/p1.jpg",
      detail: "memory://thumbs/uploads/2026/10/p1.jpg",
    })
  })

  async function exchangeAs(
    user: SeededAvatarUser,
    email: string,
  ): Promise<{ id: string; avatarUrl?: string | null }> {
    await h.sql`UPDATE users SET email = ${email} WHERE id = ${user.id}`
    app.adminAuthOverrides = {
      auditSink: () => Promise.resolve(),
      verifyAccessJwt: () => Promise.resolve({ email, commonName: null, sub: user.id, raw: {} }),
    }
    try {
      const res = await app.inject({
        method: "POST",
        url: "/v1/admin/auth/access/exchange",
        headers: { "cf-access-jwt-assertion": "stub.jwt.token" },
      })
      const body = okJson<{ user: { id: string; avatarUrl?: string | null } }>(res)
      expect(body.user.id).toBe(user.id)
      return body.user
    } finally {
      delete app.adminAuthOverrides
    }
  }

  it("T21: POST /admin/auth/access/exchange answers P with the thumbnail URL", async () => {
    const u = await seedAvatarUsers(h.sql)
    const user = await exchangeAs(u.P, EXCHANGE_EMAILS.T21)
    expect(user.avatarUrl).toBe("memory://thumbs/uploads/2026/10/p1.jpg")
  })

  it("T22: POST /admin/auth/access/exchange answers S with the served copy", async () => {
    const u = await seedAvatarUsers(h.sql)
    const user = await exchangeAs(u.S, EXCHANGE_EMAILS.T22)
    expect(user.avatarUrl).toBe("memory://processed/uploads/2026/10/s1")
  })

  it("T23: POST /admin/auth/access/exchange answers V, whose avatar is validating, with the stored URL", async () => {
    const u = await seedAvatarUsers(h.sql)
    const user = await exchangeAs(u.V, EXCHANGE_EMAILS.T23)
    expect(user.avatarUrl).toBe("https://lh3.googleusercontent.com/a/v-old")
  })

  it("T24: POST /admin/auth/access/exchange answers O, with no avatar media, with the stored URL", async () => {
    const u = await seedAvatarUsers(h.sql)
    const user = await exchangeAs(u.O, EXCHANGE_EMAILS.T24)
    expect(user.avatarUrl).toBe("https://lh3.googleusercontent.com/a/o")
  })

  it("T25: POST /admin/auth/access/exchange answers N with a null avatarUrl", async () => {
    const u = await seedAvatarUsers(h.sql)
    const user = await exchangeAs(u.N, EXCHANGE_EMAILS.T25)
    expect(user).toHaveProperty("avatarUrl", null)
  })

  async function saveProfilePhoto(
    user: SeededAvatarUser,
    status: "ready" | "validating",
  ): Promise<{ avatarUrl: string | null; mediaId: string }> {
    const media = await seedMediaAsset(h.sql, {
      status,
      r2Key: `uploads/2026/10/o2-${randomUUID()}`,
      servedKey: status === "ready" ? "processed/uploads/2026/10/o2" : null,
      thumbKey: status === "ready" ? "thumbs/uploads/2026/10/o2.jpg" : null,
      uploader: userUploader(user.id),
      finalizedAt: new Date(),
    })
    const body = await sendJson<{ user: { avatarUrl: string | null } }>(
      await signIn(user),
      "PUT",
      "/v1/me/profile",
      { handle: user.handle, displayName: user.displayName, avatarUploadId: media.uploadId },
    )
    return { avatarUrl: body.user.avatarUrl, mediaId: media.id }
  }

  it("T17: PUT /me/profile with a ready upload answers with its thumbnail and keeps avatar_url", async () => {
    const u = await seedAvatarUsers(h.sql)
    const saved = await saveProfilePhoto(u.O, "ready")
    expect(saved.avatarUrl).toBe("memory://thumbs/uploads/2026/10/o2.jpg")
    expect(await storedAvatarOf(u.O)).toEqual({
      avatar_url: "https://lh3.googleusercontent.com/a/o",
      avatar_media_id: saved.mediaId,
    })
  })

  it("T18: PUT /me/profile with a validating upload answers with the stored URL and keeps avatar_url", async () => {
    const u = await seedAvatarUsers(h.sql)
    const saved = await saveProfilePhoto(u.O, "validating")
    expect(saved.avatarUrl).toBe("https://lh3.googleusercontent.com/a/o")
    expect((await storedAvatarOf(u.O)).avatar_url).toBe("https://lh3.googleusercontent.com/a/o")
  })

  it("T20: GET /auth/session shows V's new thumbnail once the worker marked V's avatar ready", async () => {
    const u = await seedAvatarUsers(h.sql)
    const { avatar_media_id: mediaId } = await storedAvatarOf(u.V)
    // The write runMediaChecksJob makes when it passes the upload (T19 covers the job itself).
    const thumbKey = `thumbs/uploads/2026/10/${randomUUID()}.jpg`
    await makeDrizzleMediaWorkerRepository(h.db, h.sql).applyResult(mediaId!, {
      status: "ready",
      servedKey: `processed/uploads/2026/10/${randomUUID()}`,
      thumbKey,
    })
    expect((await storedAvatarOf(u.V)).avatar_url).toBe("https://lh3.googleusercontent.com/a/v-old")
    const body = await getJson<{ user: { avatarUrl: string | null } }>(
      await signIn(u.V),
      "/v1/auth/session",
    )
    expect(body.user.avatarUrl).toBe(`memory://${thumbKey}`)
  })
})
