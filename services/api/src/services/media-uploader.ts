// A caller with neither an account nor a signed anon cookie still gets a subject, so a NULL uploader only
// ever means a row written before uploads were attributed. Never an IP: the column outlives the request.
export const UNSESSIONED_UPLOADER = "anon"

export function userUploader(userId: string): string {
  return `u:${userId}`
}

export function anonUploader(anonSessionId: string): string {
  return `a:${anonSessionId}`
}

export function uploaderOf(owner: {
  userId?: string | undefined
  anonSessionId?: string | undefined
}): string {
  if (owner.userId) return userUploader(owner.userId)
  if (owner.anonSessionId) return anonUploader(owner.anonSessionId)
  return UNSESSIONED_UPLOADER
}
