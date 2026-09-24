import { describe, expect, it } from "vitest"
import { MAX_BROADCAST_BODY } from "@civfix/shared"
import { MARKDOWN_SUBSET_MAX_CHARS } from "@civfix/shared/markdown"
import {
  assertBroadcastLinkPolicy,
  broadcastLinkWarnings,
  renderBroadcast,
} from "../../src/services/host/broadcast-render.js"

const ctx = {
  eventTitle: "Beach Cleanup",
  vars: { first_name: "Alex", event_title: "Beach Cleanup" },
  unsubscribeUrl: "https://civfix.org/unsubscribe?t=abc",
}

describe("broadcast rendering", () => {
  it("escapes HTML in the body", () => {
    const out = renderBroadcast(
      { subject: "Hi", bodyMd: '<img src=x onerror="alert(1)"> & "quoted"' },
      ctx,
    )
    expect(out.html).not.toContain("<img")
    expect(out.html).not.toContain('onerror="')
    expect(out.html).toContain("&lt;img")
    expect(out.html).toContain("&quot;")
    expect(out.html).toContain("&amp;")
  })

  it("escapes HTML in the subject's preheader", () => {
    const out = renderBroadcast({ subject: "<script>x</script>", bodyMd: "hello" }, ctx)
    expect(out.html).not.toContain("<script>")
  })

  it("substitutes allowlisted variables and leaves unknown ones literal", () => {
    const out = renderBroadcast(
      { subject: "Hi {first_name}", bodyMd: "See you at {event_title}. {notAVar} stays." },
      ctx,
    )
    expect(out.subject).toBe("Hi Alex")
    expect(out.text).toContain("See you at Beach Cleanup")
    expect(out.text).toContain("{notAVar} stays.")
  })

  it("does not re-expand a variable value that looks like a variable", () => {
    const out = renderBroadcast(
      { subject: "x", bodyMd: "Hello {first_name}" },
      { ...ctx, vars: { first_name: "{event_title}" } },
    )
    expect(out.text).toContain("{event_title}")
    expect(out.text).not.toContain("Beach Cleanup.")
  })

  it("renders a markdown link as an anchor with an escaped href", () => {
    const out = renderBroadcast(
      { subject: "x", bodyMd: "[details](https://civfix.org/e/beach?a=1&b=2)" },
      ctx,
    )
    expect(out.html).toContain('href="https://civfix.org/e/beach?a=1&amp;b=2"')
  })

  it("degrades an unsafe markdown link to plain text", () => {
    const out = renderBroadcast({ subject: "x", bodyMd: "[click](javascript:alert(1))" }, ctx)
    expect(out.html).not.toContain("javascript:")
    expect(out.html).not.toContain(">click</a>")
  })

  it("renders a CTA button when a url is present", () => {
    const out = renderBroadcast(
      { subject: "x", bodyMd: "body", ctaLabel: "Sign up", ctaUrl: "https://civfix.org/e/x" },
      ctx,
    )
    expect(out.html).toContain("https://civfix.org/e/x")
    expect(out.text).toContain("Sign up: https://civfix.org/e/x")
  })

  it("truncates the push and in-app bodies", () => {
    const out = renderBroadcast({ subject: "s".repeat(200), bodyMd: "b".repeat(1000) }, ctx)
    expect(out.pushTitle.length).toBeLessThanOrEqual(40)
    expect(out.pushBody.length).toBeLessThanOrEqual(140)
    expect(out.inAppBody.length).toBeLessThanOrEqual(200)
  })

  it("puts the unsubscribe link in the bulk footer and omits it from a critical one", () => {
    const bulk = renderBroadcast({ subject: "x", bodyMd: "y" }, ctx)
    expect(bulk.text).toContain("https://civfix.org/unsubscribe?t=abc")
    expect(bulk.text).toContain("never gave them your email address")

    const critical = renderBroadcast({ subject: "x", bodyMd: "y" }, { ...ctx, critical: true })
    expect(critical.text).not.toContain("https://civfix.org/unsubscribe?t=abc")
    expect(critical.text).toContain("service message")
  })

  it("discloses a verified reply-to and says so when there is none", () => {
    const withReply = renderBroadcast(
      { subject: "x", bodyMd: "y" },
      { ...ctx, replyTo: "host@example.org" },
    )
    expect(withReply.text).toContain("host@example.org")
    const withoutReply = renderBroadcast({ subject: "x", bodyMd: "y" }, ctx)
    expect(withoutReply.text).toContain("not monitored")
  })
})

describe("broadcast link policy", () => {
  it("accepts plain https links", () => {
    expect(() => assertBroadcastLinkPolicy("see https://civfix.org/e/x", undefined)).not.toThrow()
  })

  it("refuses http, ip literals, userinfo and too many links", () => {
    expect(() => assertBroadcastLinkPolicy("http://civfix.org", undefined)).toThrow()
    expect(() => assertBroadcastLinkPolicy("https://1.2.3.4/x", undefined)).toThrow()
    expect(() => assertBroadcastLinkPolicy("https://a:b@civfix.org", undefined)).toThrow()
    const many = Array.from({ length: 6 }, (_, i) => `https://civfix.org/${i}`).join(" ")
    expect(() => assertBroadcastLinkPolicy(many, undefined)).toThrow()
  })

  it("honours the host allowlist without matching a lookalike suffix", () => {
    expect(() => assertBroadcastLinkPolicy("https://civfix.org/x", ["civfix.org"])).not.toThrow()
    expect(() =>
      assertBroadcastLinkPolicy("https://civfix.org.evil.example/x", ["civfix.org"]),
    ).toThrow()
  })

  it("reports warnings without throwing for the preview", () => {
    expect(broadcastLinkWarnings("http://civfix.org", undefined).length).toBeGreaterThan(0)
    expect(broadcastLinkWarnings("https://civfix.org", undefined)).toEqual([])
  })
})

describe("broadcast body length", () => {
  it("renders a body at the contract's maximum length untruncated", () => {
    const tail = "END-OF-BODY"
    const body = "a".repeat(MAX_BROADCAST_BODY - 2 - tail.length) + " " + tail
    expect(body).toHaveLength(MAX_BROADCAST_BODY - 1)
    const out = renderBroadcast({ subject: "Hi", bodyMd: body }, ctx)
    expect(out.text).toContain(tail)
    expect(out.html).toContain(tail)
  })

  it("pins the render cap to the contract, not to the parser default", () => {
    expect(MAX_BROADCAST_BODY).toBe(MARKDOWN_SUBSET_MAX_CHARS)
  })
})
