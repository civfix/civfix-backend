/**
 * Public author identity projection helper (App-Store-audit remediation: "Deleted User" rendering).
 *
 * Account deletion is a SOFT delete: the users row + its PII survive (so the ADMIN panel keeps the real
 * identity), but every PUBLIC author projection must render a tombstoned author as the shared
 * DELETED_USER_LABEL with NO handle, NO avatar, and a `deleted:true` flag (clients drop the profile link).
 *
 * This is the single source of truth shared by the PUBLIC chat/dm/discussion author projections so they
 * stay byte-identical. The ADMIN projections deliberately do NOT use it (operators keep the truth).
 */

import { DELETED_USER_LABEL, avatarGradient } from "@civfix/shared"

/** The deterministic avatar monogram seed pair (the return shape of avatarGradient). */
type AvatarPair = ReturnType<typeof avatarGradient>

/** The public-facing author identity fields, after applying the deleted-user tombstone rule. */
export interface PublicAuthorIdentity {
  name: string
  handle: string | null
  avatar: AvatarPair
  /** Provider photo URL — omitted (undefined) for a deleted author. */
  avatarUrl: string | undefined
  /** True when the account is tombstoned (clients render "Deleted User", no avatar, no profile link). */
  deleted: boolean
}

/**
 * Resolve a joined author row into its public identity. When `deletedAt` is non-null the author's account
 * has been deleted, so we render DELETED_USER_LABEL with a null handle, no avatar, and deleted:true. Live
 * accounts pass through their real name/handle, the deterministic avatar monogram (seeded on the stable
 * id), and any provider avatar URL.
 */
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
      // Keep a deterministic monogram seed (off the stable id) so a deleted author still renders a neutral
      // placeholder rather than a broken avatar; clients suppress it via `deleted`.
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
