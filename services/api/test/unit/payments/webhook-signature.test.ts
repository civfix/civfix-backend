import { createHmac } from "node:crypto"
import { describe, expect, it } from "vitest"
import { FakePayments, FAKE_WEBHOOK_SECRETS } from "@civfix/shared/fakes"
import { isWebhookSignatureError } from "../../../src/routes/webhooks/stripe.routes.js"

const CLOCK_MS = Date.UTC(2026, 5, 1, 12, 0, 0)

function payments(nowMs = CLOCK_MS): FakePayments {
  return new FakePayments({ now: () => nowMs })
}

function expectSignatureRejection(run: () => unknown): void {
  let thrown: unknown
  try {
    run()
  } catch (err) {
    thrown = err
  }
  expect(thrown, "expected a signature rejection").toBeDefined()
  expect(isWebhookSignatureError(thrown)).toBe(true)
}

const EVENT = {
  id: "evt_test_1",
  type: "checkout.session.completed",
  livemode: false,
  account: "acct_fake_1",
  created: Math.floor(CLOCK_MS / 1000),
  data: { object: { id: "cs_fake_1" } },
}

describe("stripe webhook signature verification", () => {
  it("accepts a correctly signed v1 payload and projects the event", () => {
    const fake = payments()
    const signed = fake.signWebhook(EVENT, "connect")
    const event = fake.verifyWebhookSignature(signed.rawBody, signed.signatureHeader, "connect")
    expect(event.id).toBe("evt_test_1")
    expect(event.type).toBe("checkout.session.completed")
    expect(event.scope).toBe("connect")
    expect(event.accountId).toBe("acct_fake_1")
    expect(event.data.object.id).toBe("cs_fake_1")
  })

  it("rejects a v0-only signature header", () => {
    const fake = payments()
    const signed = fake.signWebhook(EVENT, "connect")
    const timestamp = signed.signatureHeader.split(",")[0]
    const v0Only = `${timestamp},v0=${"0".repeat(64)}`
    expectSignatureRejection(() => fake.verifyWebhookSignature(signed.rawBody, v0Only, "connect"))
  })

  it("rejects a signature older than the tolerance window", () => {
    const signer = payments(CLOCK_MS - 301_000)
    const signed = signer.signWebhook(EVENT, "connect")
    const verifier = payments(CLOCK_MS)
    expectSignatureRejection(() => verifier.verifyWebhookSignature(signed.rawBody, signed.signatureHeader, "connect"))
  })

  it("accepts a signature inside the tolerance window", () => {
    const signer = payments(CLOCK_MS - 299_000)
    const signed = signer.signWebhook(EVENT, "connect")
    const verifier = payments(CLOCK_MS)
    expect(
      verifier.verifyWebhookSignature(signed.rawBody, signed.signatureHeader, "connect").id,
    ).toBe("evt_test_1")
  })

  it("rejects a forged signature and a tampered body", () => {
    const fake = payments()
    const signed = fake.signWebhook(EVENT, "connect")
    expectSignatureRejection(() => fake.verifyWebhookSignature(signed.rawBody, signed.signatureHeader.replace(/.$/, "0"), "connect"))
    expectSignatureRejection(() => fake.verifyWebhookSignature(
        signed.rawBody.replace("cs_fake_1", "cs_attacker"),
        signed.signatureHeader,
        "connect",
      ))
  })

  it("rejects a connect-signed payload presented on the platform scope", () => {
    const fake = payments()
    const signed = fake.signWebhook(EVENT, "connect")
    expectSignatureRejection(() => fake.verifyWebhookSignature(signed.rawBody, signed.signatureHeader, "platform"))
  })

  it("accepts one matching v1 among several, so a secret roll can overlap", () => {
    const fake = payments()
    const signed = fake.signWebhook(EVENT, "connect")
    const good = signed.signatureHeader.split("v1=")[1] as string
    const timestamp = signed.signatureHeader.split(",")[0] as string
    const rolled = `${timestamp},v1=${"a".repeat(64)},v1=${good}`
    expect(fake.verifyWebhookSignature(signed.rawBody, rolled, "connect").id).toBe("evt_test_1")
  })

  it("rejects a correctly signed body that is not JSON", () => {
    const fake = payments()
    const timestamp = Math.floor(CLOCK_MS / 1000)
    const rawBody = "not json"
    const signature = createHmac("sha256", FAKE_WEBHOOK_SECRETS.connect)
      .update(`${timestamp}.${rawBody}`)
      .digest("hex")
    expectSignatureRejection(() => fake.verifyWebhookSignature(rawBody, `t=${timestamp},v1=${signature}`, "connect"))
  })

  it("rejects an empty or malformed header", () => {
    const fake = payments()
    const signed = fake.signWebhook(EVENT, "connect")
    for (const header of ["", "garbage", "t=,v1=", `v1=${"a".repeat(64)}`]) {
      expectSignatureRejection(() => fake.verifyWebhookSignature(signed.rawBody, header, "connect"))
    }
  })
})
