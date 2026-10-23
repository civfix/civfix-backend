/**
 * The GH#209 avatar fixtures, shared by both resolver slices: six users whose stored avatar_url and avatar
 * media cover every branch of the resolver. Storage is the seams fake, so a key presigns to memory://<key>.
 */

import { randomUUID } from "node:crypto"
import type { Queryable } from "../../src/db/client.js"
import { userUploader } from "../../src/services/media-uploader.js"
import { FakeStorage } from "@civfix/seams"
import {
  avatarPresigner,
  type AvatarPresigner,
  type UserAvatarSource,
} from "../../src/services/user-avatar.js"
import { seedMediaAsset, type SeedMediaStatus } from "./media-pg.js"

export type AvatarFixtureName = "P" | "S" | "V" | "R" | "O" | "N"

export const AVATAR_FIXTURE_NAMES: readonly AvatarFixtureName[] = ["P", "S", "V", "R", "O", "N"]

interface FixtureMedia {
  status: SeedMediaStatus
  servedKey: string | null
  thumbKey: string | null
}

interface Fixture {
  avatarUrl: string | null
  media: FixtureMedia | null
}

export const AVATAR_FIXTURES: Readonly<Record<AvatarFixtureName, Fixture>> = {
  P: {
    avatarUrl: "cdn.civfix.org/processed/uploads/2026/10/p1",
    media: {
      status: "ready",
      servedKey: "processed/uploads/2026/10/p1",
      thumbKey: "thumbs/uploads/2026/10/p1.jpg",
    },
  },
  S: {
    avatarUrl: null,
    media: { status: "ready", servedKey: "processed/uploads/2026/10/s1", thumbKey: null },
  },
  V: {
    avatarUrl: "https://lh3.googleusercontent.com/a/v-old",
    media: { status: "validating", servedKey: null, thumbKey: null },
  },
  R: {
    avatarUrl: "https://lh3.googleusercontent.com/a/r-old",
    media: { status: "rejected", servedKey: null, thumbKey: null },
  },
  O: { avatarUrl: "https://lh3.googleusercontent.com/a/o", media: null },
  N: { avatarUrl: null, media: null },
}

/** What each fixture user resolves to through fake storage; null is "no URL". */
export const RESOLVED_AVATAR: Readonly<Record<AvatarFixtureName, string | null>> = {
  P: "memory://thumbs/uploads/2026/10/p1.jpg",
  S: "memory://processed/uploads/2026/10/s1",
  V: "https://lh3.googleusercontent.com/a/v-old",
  R: "https://lh3.googleusercontent.com/a/r-old",
  O: "https://lh3.googleusercontent.com/a/o",
  N: null,
}

export function avatarFixtureSource(name: AvatarFixtureName): UserAvatarSource {
  const f = AVATAR_FIXTURES[name]
  return {
    avatarUrl: f.avatarUrl,
    avatarMedia:
      f.media === null
        ? null
        : { status: f.media.status, servedKey: f.media.servedKey, thumbKey: f.media.thumbKey },
  }
}

export interface SeededAvatarUser {
  id: string
  handle: string
  displayName: string
  email: string
}

/**
 * Inserts one users row per fixture, each with its own avatar media row. Every call makes fresh users, so
 * a case's follows and blocks never leak into another case.
 */
export async function seedAvatarUsers(
  sql: Queryable,
): Promise<Record<AvatarFixtureName, SeededAvatarUser>> {
  const tag = randomUUID().slice(0, 8)
  const out = {} as Record<AvatarFixtureName, SeededAvatarUser>
  for (const name of AVATAR_FIXTURE_NAMES) {
    const f = AVATAR_FIXTURES[name]
    const handle = `u${randomUUID().replace(/-/g, "").slice(0, 12)}`
    const displayName = `Avatar ${tag} ${name}`
    const email = `${handle}@civfix.test`
    const [u] = await sql<{ id: string }[]>`
      INSERT INTO users (display_name, handle, email, email_verified, avatar_url, profile_complete)
      VALUES (${displayName}, ${handle}, ${email}, true, ${f.avatarUrl}, true)
      RETURNING id
    `
    const id = u!.id
    if (f.media !== null) {
      const media = await seedMediaAsset(sql, {
        status: f.media.status,
        servedKey: f.media.servedKey,
        thumbKey: f.media.thumbKey,
        uploader: userUploader(id),
      })
      await sql`UPDATE users SET avatar_media_id = ${media.id} WHERE id = ${id}`
    }
    out[name] = { id, handle, displayName, email }
  }
  return out
}

/** The container's avatar presigner over the seams fake storage: a key becomes memory://<key>. */
export const fakeAvatarPresigner: AvatarPresigner = avatarPresigner(new FakeStorage())
