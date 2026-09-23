export const CIVFIX_OFFICIAL_USER_ID = "00000000-0000-4000-8000-00000000c1f1"

export const CIVFIX_OFFICIAL_HANDLE = "civfix"

export const CIVFIX_OFFICIAL_DISPLAY_NAME = "CivFix"

export function isOfficialAccount(userId: string | null | undefined): boolean {
  return typeof userId === "string" && userId.toLowerCase() === CIVFIX_OFFICIAL_USER_ID
}
