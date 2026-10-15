import { describe, expect, it } from "vitest"
import { containsSlur } from "../../src/abuse/slur-filter.js"

const COMBINING_DIAERESIS = "̈"
const COMBINING_ACUTE = "́"
const ZERO_WIDTH_SPACE = "​"
const ZERO_WIDTH_NON_JOINER = "‌"
const ZERO_WIDTH_JOINER = "‍"
const SOFT_HYPHEN = "­"
const RIGHT_TO_LEFT_MARK = "‏"
const BYTE_ORDER_MARK = "﻿"

describe("containsSlur sees through invisible and combining characters", () => {
  const disguised: ReadonlyArray<readonly [label: string, text: string]> = [
    ["combining diaeresis", `fa${COMBINING_DIAERESIS}ggot`],
    ["combining acute", `re${COMBINING_ACUTE}tard`],
    ["precomposed accented letter", "rétard"],
    ["precomposed i-diaeresis", "retarded fäggot"],
    ["zero-width space", `ret${ZERO_WIDTH_SPACE}ard`],
    ["zero-width non-joiner", `tran${ZERO_WIDTH_NON_JOINER}ny`],
    ["zero-width joiner", `ret${ZERO_WIDTH_JOINER}ard`],
    ["soft hyphen", `tran${SOFT_HYPHEN}ny`],
    ["right-to-left mark", `ret${RIGHT_TO_LEFT_MARK}ard`],
    ["byte order mark", `tran${BYTE_ORDER_MARK}ny`],
    ["mark and format char together", `re${COMBINING_ACUTE}${ZERO_WIDTH_SPACE}tard`],
  ]

  it.each(disguised)("blocks a slur disguised with a %s", (_label, text) => {
    expect(containsSlur(text)).toBe(true)
  })

  it("still treats a zero-width space as a word gap", () => {
    expect(containsSlur(`hello${ZERO_WIDTH_SPACE}retard`)).toBe(true)
  })

  const benign = ["naïve", "café", "résumé", `co${ZERO_WIDTH_JOINER}operate`, "über"]
  it.each(benign)("leaves the benign word %j alone", (text) => {
    expect(containsSlur(text)).toBe(false)
  })
})
