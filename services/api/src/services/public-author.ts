// Account deletion is a soft delete: the users row and its PII survive so the admin panel keeps the
// real identity, but every public author projection must show a deleted author as DELETED_USER_LABEL
// with no handle and no avatar photo. The public chat, DM and discussion projections share this helper
// so they stay identical; admin projections deliberately do not use it.

import { DELETED_USER_LABEL, avatarGradient } from "@civfix/shared"

type AvatarPair = ReturnType<typeof avatarGradient>

export interface PublicAuthorIdentity {
  name: string
  handle: string | null
  avatar: AvatarPair
  /** Provider photo URL; undefined for a deleted author. */
  avatarUrl: string | undefined
  /** Clients drop the avatar and the profile link when set. */
  deleted: boolean
}

export function publicAuthorIdentity(input: {
  id: string
  displayName: string | null
  handle: string | null
  avatarUrl?: string | null
  deletedAt: Date | null
}): PublicAuthorIdentity {
  if (input.deletedAt !== null) {
    return {
      name: DELETED_USER_LABEL,
      handle: null,
      // Seeded off the stable id so a deleted author still renders a neutral placeholder rather than a
      // broken avatar; clients suppress it via `deleted`.
      avatar: avatarGradient(input.id),
      avatarUrl: undefined,
      deleted: true,
    }
  }
  return {
    name: input.displayName ?? "",
    handle: input.handle,
    avatar: avatarGradient(input.id),
    avatarUrl: input.avatarUrl ?? undefined,
    deleted: false,
  }
}
