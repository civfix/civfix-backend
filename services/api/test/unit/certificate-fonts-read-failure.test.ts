import type { PathLike } from "node:fs"
import { describe, expect, it, vi } from "vitest"
import { FONT } from "../../src/services/certificate-fonts.js"
import { buildTranscriptModel } from "../../src/services/certificate-model.js"
import { buildServiceHoursPdf } from "../../src/services/certificate-pdf.js"

const noto = vi.hoisted(() => ({
  file: "NotoSansKR-Regular.otf",
  fail: true,
  reads: 0,
  error: Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" }),
}))

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>()
  return {
    ...actual,
    readFile: (path: PathLike) => {
      if (!String(path).endsWith(noto.file)) return actual.readFile(path)
      noto.reads += 1
      return noto.fail ? Promise.reject(noto.error) : actual.readFile(path)
    },
  }
})

const HOLDER = {
  userId: "11111111-1111-4111-8111-111111111111",
  displayName: "Jane Doe",
  handle: "jane",
  verified: true,
}

function render(eventTitle: string, locale: string): Promise<Uint8Array> {
  const model = buildTranscriptModel({
    holder: HOLDER,
    locale,
    rows: [
      {
        id: "row-00000",
        source: "event",
        hours: 2.5,
        occurredAt: "2026-01-01T00:00:00.000Z",
        eventTitle,
        jurisdictionName: "Los Angeles",
        creditedByName: "Ada Host",
      },
    ],
  })
  return buildServiceHoursPdf({
    model,
    code: "A1B2C3D4E5F6",
    issuedAt: new Date("2026-07-27T18:22:04.000Z"),
    fingerprint: "f".repeat(64),
  })
}

describe("certificate font read failure", () => {
  it("fails only the documents that use the unreadable face, and retries the read", async () => {
    expect(FONT.cjk).toBe(noto.file)

    const latin = await render("Beach cleanup at the pier", "en")
    expect(Buffer.from(latin.subarray(0, 5)).toString("latin1")).toBe("%PDF-")
    expect(noto.reads).toBe(1)

    await expect(render("강남구 해변 청소", "ko")).rejects.toBe(noto.error)
    expect(noto.reads).toBe(2)

    noto.fail = false
    const cjk = await render("강남구 해변 청소", "ko")
    expect(Buffer.from(cjk.subarray(0, 5)).toString("latin1")).toBe("%PDF-")
    expect(noto.reads).toBe(3)

    await render("강남구 해변 청소", "ko")
    expect(noto.reads).toBe(3)
  })
})
