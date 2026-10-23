import type { Storage } from "@civfix/seams"

export interface AvatarMedia {
  status: string
  servedKey: string | null
  thumbKey: string | null
}

export interface UserAvatarSource {
  avatarUrl: string | null
  avatarMedia: AvatarMedia | null
}

export type AvatarPresigner = (key: string) => Promise<string>

export function avatarPresigner(_storage: Pick<Storage, "presignGet">): AvatarPresigner {
  throw new Error("not implemented")
}

export function resolveUserAvatarUrl(
  _presign: AvatarPresigner,
  _user: UserAvatarSource,
): Promise<string | null> {
  throw new Error("not implemented")
}
