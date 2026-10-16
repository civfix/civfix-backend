import { describe, expect, it } from "vitest"
import { formatCertificateCode } from "@civfix/contract"
import { FakeStorage } from "../src/fakes/storage.fake.js"
import { FakeSmsSender } from "../src/fakes/sms-sender.fake.js"

const CODE = "__CODE__"
const PHONE = "__PHONE__"

describe("FakeStorage contentDisposition", () => {
  it("stores the disposition on put() and surfaces it from head()", async () => {
    const s = new FakeStorage()
    const disposition = `inline; filename="civfix-service-hours-${formatCertificateCode(CODE)}.pdf"`
    await s.put("certificates/service-hours/2026/07/x.pdf", new Uint8Array([1, 2, 3]), {
      contentType: "application/pdf",
      contentDisposition: disposition,
    })
    const head = await s.head("certificates/service-hours/2026/07/x.pdf")
    expect(head).toEqual({
      size: 3,
      contentType: "application/pdf",
      contentDisposition: disposition,
    })
  })

  it("omits the disposition when put() was given none", async () => {
    const s = new FakeStorage()
    await s.put("k", new Uint8Array([1]), { contentType: "image/png" })
    expect(await s.head("k")).toEqual({ size: 1, contentType: "image/png" })
  })
})

describe("FakeSmsSender", () => {
  it("captures sends with deterministic ids", async () => {
    const sms = new FakeSmsSender()
    const first = await sms.send(PHONE, "code 123456")
    const second = await sms.send(PHONE, "code 654321")
    expect(first.id).toBe("fake-sms-1")
    expect(second.id).toBe("fake-sms-2")
    expect(sms.sent).toHaveLength(2)
    expect(sms.lastFor(PHONE)?.body).toBe("code 654321")
    expect(sms.lastFor("+13105550100")).toBeUndefined()
  })

  it("resets its capture log and its id counter", async () => {
    const sms = new FakeSmsSender()
    await sms.send(PHONE, "one")
    sms.reset()
    expect(sms.sent).toHaveLength(0)
    expect((await sms.send(PHONE, "two")).id).toBe("fake-sms-1")
  })
})
