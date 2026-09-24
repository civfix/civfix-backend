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

// Every subject this caller's request proves, where uploaderOf picks the one a new upload is stored under:
// a guest who signs in between presign and finalize or submit still owns the uploads its anon cookie
// created, as long as the signed-in request carries that same verified cookie.
export function uploadersOf(owner: {
  userId?: string | undefined
  anonSessionId?: string | undefined
  guestAnonSessionId?: string | undefined
}): string[] {
  const subjects: string[] = []
  if (owner.userId) subjects.push(userUploader(owner.userId))
  if (owner.anonSessionId) subjects.push(anonUploader(owner.anonSessionId))
  if (owner.guestAnonSessionId && owner.guestAnonSessionId !== owner.anonSessionId) {
    subjects.push(anonUploader(owner.guestAnonSessionId))
  }
  return subjects.length > 0 ? subjects : [UNSESSIONED_UPLOADER]
}
