import { describe, expect, it } from "vitest"
import { FakeStorage } from "@civfix/seams"
import { R2Storage } from "../../src/adapters/storage.r2.js"
import { avatarPresigner, resolveUserAvatarUrl } from "../../src/services/user-avatar.js"
import {
  AVATAR_FIXTURE_NAMES,
  RESOLVED_AVATAR,
  avatarFixtureSource,
} from "../helpers/avatar-fixtures.js"

function r2WithPublicBase(publicBase: string): R2Storage {
  return new R2Storage({
    accountId: "acct",
    accessKeyId: "key",
    secretAccessKey: "secret",
    bucket: "civfix-media",
    publicBase,
  })
}

describe("resolveUserAvatarUrl", () => {
  it("T1: a scheme-less public base still yields an https URL of the thumbnail", async () => {
    const presign = avatarPresigner(r2WithPublicBase("cdn.civfix.org"))
    expect(await resolveUserAvatarUrl(presign, avatarFixtureSource("P"))).toBe(
      "https://cdn.civfix.org/thumbs/uploads/2026/10/p1.jpg",
    )
  })

  it("T2: a public base with a scheme and a trailing slash yields the same URL", async () => {
    const presign = avatarPresigner(r2WithPublicBase("https://cdn.civfix.org/"))
    expect(await resolveUserAvatarUrl(presign, avatarFixtureSource("P"))).toBe(
      "https://cdn.civfix.org/thumbs/uploads/2026/10/p1.jpg",
    )
  })

  it("T3: P thumb, S served, V R O stored, N none", async () => {
    const presign = avatarPresigner(new FakeStorage())
    const resolved: Record<string, string | null> = {}
    for (const name of AVATAR_FIXTURE_NAMES) {
      resolved[name] = await resolveUserAvatarUrl(presign, avatarFixtureSource(name))
    }
    expect(resolved).toEqual({
      P: "memory://thumbs/uploads/2026/10/p1.jpg",
      S: "memory://processed/uploads/2026/10/s1",
      V: "https://lh3.googleusercontent.com/a/v-old",
      R: "https://lh3.googleusercontent.com/a/r-old",
      O: "https://lh3.googleusercontent.com/a/o",
      N: null,
    })
    expect(resolved).toEqual(RESOLVED_AVATAR)
  })
})
