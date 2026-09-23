export const CIVFIX_OFFICIAL_USER_ID = "00000000-0000-4000-8000-00000000c1f1"

export const CIVFIX_OFFICIAL_HANDLE = "civfix"

export const CIVFIX_OFFICIAL_DISPLAY_NAME = "CivFix"

export function isOfficialAccount(userId: string | null | undefined): boolean {
  return typeof userId === "string" && userId.toLowerCase() === CIVFIX_OFFICIAL_USER_ID
}

const NAME_LOOKALIKES: Readonly<Record<string, string>> = {
  "1": "i",
  "!": "i",
  "|": "i",
  l: "i",
  "\u0131": "i",
  "\u03b9": "i",
  "\u0456": "i",
  "\u03f2": "c",
  "\u0441": "c",
  "\u03bd": "v",
  "\u0475": "v",
  "\u0192": "f",
  "\u00d7": "x",
  "\u03c7": "x",
  "\u0445": "x",
}

function nameKey(name: string): string {
  let key = ""
  for (const ch of name.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase()) {
    const mapped = NAME_LOOKALIKES[ch] ?? ch
    if (/^[a-z0-9]$/.test(mapped)) key += mapped
  }
  return key
}

const OFFICIAL_NAME_KEY = nameKey(CIVFIX_OFFICIAL_DISPLAY_NAME)

export function impersonatesOfficialName(name: string): boolean {
  return nameKey(name) === OFFICIAL_NAME_KEY
}
