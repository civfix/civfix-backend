import type { PersonDTO } from "@civfix/shared"
import { publicAuthorIdentity } from "./public-author.js"
import { hiddenIdentity } from "./hidden-identity.js"

export interface RoomMemberIdentityRow {
  user_id: string
  display_name: string | null
  handle: string | null
  bio: string | null
  avatar_url: string | null
  user_deleted_at: Date | null
  is_following: boolean
  blocked_pair: boolean
}

// Report and group rosters share this mapper so a deleted or blocked member redacts identically in both.
export function toRoomMemberPerson(r: RoomMemberIdentityRow): PersonDTO {
  const author = publicAuthorIdentity({
    id: r.user_id,
    displayName: r.display_name ?? "",
    handle: r.handle,
    avatarUrl: r.avatar_url,
    deletedAt: r.user_deleted_at,
  })
  const hidden = r.blocked_pair && !author.deleted ? hiddenIdentity(r.user_id) : null
  return {
    id: r.user_id,
    name: hidden?.name ?? author.name,
    handle: hidden !== null ? null : author.handle,
    bio: author.deleted || hidden !== null ? null : r.bio,
    avatar: author.avatar,
    ...(hidden === null && author.avatarUrl !== undefined ? { avatarUrl: author.avatarUrl } : {}),
    followers: 0,
    following: 0,
    isFollowing: r.is_following,
    ...(author.deleted ? { deleted: true } : {}),
  }
}
