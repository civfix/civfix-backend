/**
 * GH#209: every route that shows a user's profile photo returns the one resolved avatar URL (the ready
 * avatar media's thumbnail, else its served copy, else the stored avatar_url), through the real Fastify
 * app on PostGIS with the container's own wiring. Storage is the seams fake, so keys presign to
 * https://fake-storage.invalid/<key>. The users P, S, V, R, O and N are the shared fixtures in
 * test/helpers/avatar-fixtures.ts; every case seeds its own set.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { FastifyInstance, LightMyRequestResponse } from "fastify"
import type { FakeMailer } from "@civfix/seams"
import type { PersonDTO } from "@civfix/contract"
import { withPg, type PgHarness, seedFollowEdge } from "../helpers/pg.js"
import { makeServer } from "../../src/server.js"
import { makeContainer, type Container } from "../../src/di.js"
import { loadEnv } from "../../src/env.js"
import { InMemoryCacheClient } from "../../src/auth/cache.js"
import { PgAuthStores } from "../../src/auth/pg-stores.js"
import { makeAuthServices, type AuthServices } from "../../src/auth/auth-services.js"
import {
  RESOLVED_AVATAR,
  seedAvatarUsers,
  type AvatarFixtureName,
  type SeededAvatarUser,
} from "../helpers/avatar-fixtures.js"

const pg = await withPg()

interface Session {
  cookie: string
  csrfToken: string
}

describe.skipIf(!pg)("user avatar URLs on routes (integration)", () => {
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

  async function signIn(user: SeededAvatarUser): Promise<Session> {
    const token = await authServices.sessions.createSession(user.id, ["citizen"])
    const csrfToken = await container.csrf.tokenForSession(token)
    return { cookie: `civfix_session=${token}`, csrfToken }
  }

  function get(s: Session | null, url: string): Promise<LightMyRequestResponse> {
    return app.inject({ method: "GET", url, headers: s === null ? {} : { cookie: s.cookie } })
  }

  function put(s: Session, url: string, payload: object): Promise<LightMyRequestResponse> {
    return app.inject({
      method: "PUT",
      url,
      headers: { cookie: s.cookie, "x-csrf-token": s.csrfToken },
      payload,
    })
  }

  async function post(author: SeededAvatarUser, body: string): Promise<string> {
    const [row] = await h.sql<{ id: string }[]>`
      INSERT INTO posts (author_id, kind, body) VALUES (${author.id}, 'post', ${body}) RETURNING id
    `
    return row!.id
  }

  function okJson<T>(res: LightMyRequestResponse): T {
    expect(res.statusCode, res.body).toBe(200)
    return res.json<T>()
  }

  function avatarOf(people: PersonDTO[], user: SeededAvatarUser): PersonDTO["avatarUrl"] {
    const person = people.find((p) => p.id === user.id)
    expect(person, `${user.displayName} is listed`).toBeDefined()
    return person!.avatarUrl
  }

  it("T4: GET /auth/session returns the resolved avatar for P, S, V and O, and null for N", async () => {
    const u = await seedAvatarUsers(h.sql)
    const seen: Partial<Record<AvatarFixtureName, string | null>> = {}
    for (const name of ["P", "S", "V", "O", "N"] as const) {
      const body = okJson<{ user: { avatarUrl: string | null } }>(
        await get(await signIn(u[name]), "/v1/auth/session"),
      )
      seen[name] = body.user.avatarUrl
    }
    expect(seen).toEqual({
      P: RESOLVED_AVATAR.P,
      S: RESOLVED_AVATAR.S,
      V: RESOLVED_AVATAR.V,
      O: RESOLVED_AVATAR.O,
      N: null,
    })
  })

  it("T5: POST /auth/otp/verify signs P in with the thumbnail URL", async () => {
    const u = await seedAvatarUsers(h.sql)
    const requested = await app.inject({
      method: "POST",
      url: "/v1/auth/otp/request",
      headers: { "x-client": "mobile" },
      payload: { email: u.P.email },
    })
    expect(requested.statusCode, requested.body).toBe(200)
    const code = (container.mailer as FakeMailer).lastOtpFor(u.P.email)
    const body = okJson<{ user: { avatarUrl: string | null } }>(
      await app.inject({
        method: "POST",
        url: "/v1/auth/otp/verify",
        headers: { "x-client": "mobile" },
        payload: { email: u.P.email, code },
      }),
    )
    expect(body.user.avatarUrl).toBe("https://fake-storage.invalid/thumbs/uploads/2026/10/p1.jpg")
  })

  it("T6: PUT /me/profile without avatarUploadId answers with P's thumbnail URL", async () => {
    const u = await seedAvatarUsers(h.sql)
    const body = okJson<{ user: { avatarUrl: string | null } }>(
      await put(await signIn(u.P), "/v1/me/profile", {
        handle: u.P.handle,
        displayName: u.P.displayName,
      }),
    )
    expect(body.user.avatarUrl).toBe("https://fake-storage.invalid/thumbs/uploads/2026/10/p1.jpg")
  })

  it("T7: PUT /me/settings answers with P's thumbnail URL", async () => {
    const u = await seedAvatarUsers(h.sql)
    const body = okJson<{ user: { avatarUrl: string | null } }>(
      await put(await signIn(u.P), "/v1/me/settings", { allowDirectMessages: false }),
    )
    expect(body.user.avatarUrl).toBe("https://fake-storage.invalid/thumbs/uploads/2026/10/p1.jpg")
  })

  it("T8: GET /feed/home shows each followed author's resolved avatar", async () => {
    const u = await seedAvatarUsers(h.sql)
    const viewer = (await seedAvatarUsers(h.sql)).N
    const postIds: Partial<Record<AvatarFixtureName, string>> = {}
    for (const name of ["P", "S", "V", "O"] as const) {
      await seedFollowEdge(h.sql, viewer.id, u[name].id)
      postIds[name] = await post(u[name], `home feed post by ${name}`)
    }
    const page = okJson<{ items: Array<{ id: string; author: PersonDTO }> }>(
      await get(await signIn(viewer), "/v1/feed/home?limit=50"),
    )
    const avatars: Partial<Record<AvatarFixtureName, PersonDTO["avatarUrl"]>> = {}
    for (const name of ["P", "S", "V", "O"] as const) {
      const item = page.items.find((p) => p.id === postIds[name])
      expect(item, `post by ${name} is in the feed`).toBeDefined()
      avatars[name] = item!.author.avatarUrl
    }
    expect(avatars).toEqual({
      P: "https://fake-storage.invalid/thumbs/uploads/2026/10/p1.jpg",
      S: "https://fake-storage.invalid/processed/uploads/2026/10/s1",
      V: "https://lh3.googleusercontent.com/a/v-old",
      O: "https://lh3.googleusercontent.com/a/o",
    })
  })

  it("T9: GET /posts/:id shows the quoted post's author with P's thumbnail URL", async () => {
    const u = await seedAvatarUsers(h.sql)
    const quoted = await post(u.P, "the quoted post")
    const [row] = await h.sql<{ id: string }[]>`
      INSERT INTO posts (author_id, kind, body, repost_of_id)
      VALUES (${u.N.id}, 'quote', 'quoting P', ${quoted})
      RETURNING id
    `
    const body = okJson<{ repostOf: { author: PersonDTO | null } | null }>(
      await get(await signIn(u.N), `/v1/posts/${row!.id}`),
    )
    expect(body.repostOf?.author?.avatarUrl).toBe(
      "https://fake-storage.invalid/thumbs/uploads/2026/10/p1.jpg",
    )
  })

  it("T10: GET /people/:id (viewer O) and GET /me/profile (P) show P's thumbnail URL", async () => {
    const u = await seedAvatarUsers(h.sql)
    const other = okJson<{ profile: { avatarUrl?: string } }>(
      await get(await signIn(u.O), `/v1/people/${u.P.id}`),
    )
    const mine = okJson<{ profile: { avatarUrl?: string } }>(
      await get(await signIn(u.P), "/v1/me/profile"),
    )
    expect(other.profile.avatarUrl).toBe(
      "https://fake-storage.invalid/thumbs/uploads/2026/10/p1.jpg",
    )
    expect(mine.profile.avatarUrl).toBe(
      "https://fake-storage.invalid/thumbs/uploads/2026/10/p1.jpg",
    )
  })

  it("T11: GET /people/:id/followers and /following list P with the thumbnail and S with the served copy", async () => {
    const u = await seedAvatarUsers(h.sql)
    for (const name of ["P", "S"] as const) {
      await seedFollowEdge(h.sql, u[name].id, u.O.id)
      await seedFollowEdge(h.sql, u.O.id, u[name].id)
    }
    const session = await signIn(u.O)
    for (const list of ["followers", "following"]) {
      const page = okJson<{ items: PersonDTO[] }>(
        await get(session, `/v1/people/${u.O.id}/${list}`),
      )
      expect({ list, P: avatarOf(page.items, u.P), S: avatarOf(page.items, u.S) }).toEqual({
        list,
        P: "https://fake-storage.invalid/thumbs/uploads/2026/10/p1.jpg",
        S: "https://fake-storage.invalid/processed/uploads/2026/10/s1",
      })
    }
  })

  it("T12: GET /people lists P with the thumbnail and V with the stored URL", async () => {
    const u = await seedAvatarUsers(h.sql)
    const tag = u.P.displayName.split(" ")[1]!
    const page = okJson<{ items: PersonDTO[] }>(
      await get(await signIn(u.N), `/v1/people?q=${encodeURIComponent(tag)}&limit=50`),
    )
    expect({ P: avatarOf(page.items, u.P), V: avatarOf(page.items, u.V) }).toEqual({
      P: "https://fake-storage.invalid/thumbs/uploads/2026/10/p1.jpg",
      V: "https://lh3.googleusercontent.com/a/v-old",
    })
  })

  it("T13: GET /users/follow-suggestions suggests P to N with the thumbnail URL", async () => {
    const u = await seedAvatarUsers(h.sql)
    const body = okJson<{ results: PersonDTO[] }>(
      await get(await signIn(u.N), "/v1/users/follow-suggestions?limit=20"),
    )
    expect(avatarOf(body.results, u.P)).toBe(
      "https://fake-storage.invalid/thumbs/uploads/2026/10/p1.jpg",
    )
  })

  it("T14: GET /users/search and /users/mention-search find P with the thumbnail URL", async () => {
    const u = await seedAvatarUsers(h.sql)
    const session = await signIn(u.O)
    for (const path of ["/v1/users/search", "/v1/users/mention-search"]) {
      const body = okJson<{ results: Array<{ id: string; avatarUrl?: string }> }>(
        await get(session, `${path}?q=${u.P.handle}`),
      )
      const hit = body.results.find((r) => r.id === u.P.id)
      expect({ path, avatarUrl: hit?.avatarUrl }).toEqual({
        path,
        avatarUrl: "https://fake-storage.invalid/thumbs/uploads/2026/10/p1.jpg",
      })
    }
  })

  it("T15: GET /me/blocks lists the blocked P with the thumbnail URL", async () => {
    const u = await seedAvatarUsers(h.sql)
    await h.sql`INSERT INTO user_blocks (blocker_id, blocked_id) VALUES (${u.O.id}, ${u.P.id})`
    const body = okJson<{ blocked: PersonDTO[] }>(await get(await signIn(u.O), "/v1/me/blocks"))
    expect(avatarOf(body.blocked, u.P)).toBe(
      "https://fake-storage.invalid/thumbs/uploads/2026/10/p1.jpg",
    )
  })

  it("T16: GET /posts/:id of a soft-deleted P shows the author without an avatar URL", async () => {
    const u = await seedAvatarUsers(h.sql)
    const id = await post(u.P, "posted before the account closed")
    await h.sql`UPDATE users SET deleted_at = now() WHERE id = ${u.P.id}`
    const body = okJson<{ author: PersonDTO }>(await get(await signIn(u.N), `/v1/posts/${id}`))
    expect(body.author.deleted).toBe(true)
    expect(body.author).not.toHaveProperty("avatarUrl")
  })

  it("T17: GET /people/:id of a P that O blocked is the shell without an avatar URL", async () => {
    const u = await seedAvatarUsers(h.sql)
    await h.sql`INSERT INTO user_blocks (blocker_id, blocked_id) VALUES (${u.O.id}, ${u.P.id})`
    const body = okJson<{ profile: { blockedByMe?: boolean } }>(
      await get(await signIn(u.O), `/v1/people/${u.P.id}`),
    )
    expect(body.profile.blockedByMe).toBe(true)
    expect(body.profile).not.toHaveProperty("avatarUrl")
  })
})
