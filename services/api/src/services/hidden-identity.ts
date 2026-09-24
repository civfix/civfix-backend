import { avatarGradient } from "@civfix/shared"

export { blockedPairExpr } from "./blocks-sql.js"

export const HIDDEN_USER_LABEL = "Community member"

type AvatarPair = ReturnType<typeof avatarGradient>

export interface HiddenIdentity {
  name: string
  avatar: AvatarPair
}

export function hiddenIdentity(userId: string): HiddenIdentity {
  return { name: HIDDEN_USER_LABEL, avatar: avatarGradient(userId) }
}
