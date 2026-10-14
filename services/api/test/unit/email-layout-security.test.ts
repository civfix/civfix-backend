import { describe, expect, it } from "vitest"
import { eventFooter, renderEmailBody } from "../../src/adapters/email-layout.js"
import { paragraph } from "../../src/adapters/email-blocks.js"

const UNSUBSCRIBE_URL = "https://civfix.org/unsubscribe?t=abc&x=1"
const MANAGE_URL = "https://civfix.org/e/beach"
const LURE_URL = "https://civfix-login.example/verify"

function render(footer: Parameters<typeof renderEmailBody>[0]["footer"]) {
  return renderEmailBody({ blocks: [paragraph("x")], footer })
}

describe("event footer links", () => {
  it("does not turn a URL in the host-authored event title into a link", () => {
    const { html } = render(
      eventFooter({ eventTitle: `Cleanup ${LURE_URL}`, unsubscribeUrl: UNSUBSCRIBE_URL }),
    )

    expect(html).not.toContain(`href="${LURE_URL}`)
    expect(html).toContain(`Cleanup ${LURE_URL}`)
  })

  it("does not turn a URL in the organizer reply address line into a link", () => {
    const { html } = render(
      eventFooter({ eventTitle: "Beach", replyTo: `host@example.org ${LURE_URL}` }),
    )

    expect(html).not.toContain(`href="${LURE_URL}`)
  })

  it("still links the unsubscribe and manage URLs the code supplies", () => {
    const { html } = render(
      eventFooter({
        eventTitle: `Cleanup ${LURE_URL}`,
        unsubscribeUrl: UNSUBSCRIBE_URL,
        manageUrl: MANAGE_URL,
      }),
    )

    expect(html).toContain('href="https://civfix.org/unsubscribe?t=abc&amp;x=1"')
    expect(html).toContain(`href="${MANAGE_URL}"`)
    expect(html.match(/<a class="cv-link"/g)).toHaveLength(2)
  })

  it("escapes markup in the event title", () => {
    const { html } = render(eventFooter({ eventTitle: '<a href="https://x.example">x</a>' }))

    expect(html).not.toContain('<a href="https://x.example">')
    expect(html).toContain("&lt;a href=&quot;https://x.example&quot;&gt;")
  })

  it("keeps the plain-text footer byte-identical", () => {
    const opts = {
      eventTitle: `Cleanup ${LURE_URL}`,
      unsubscribeUrl: UNSUBSCRIBE_URL,
      manageUrl: MANAGE_URL,
      replyTo: "host@example.org",
    }
    const { text } = render(eventFooter(opts))

    expect(text).toBe(
      [
        "x",
        "--",
        [
          `You're receiving this because you signed up for "Cleanup ${LURE_URL}" on civfix. ` +
            "The organizer wrote this message; civfix delivered it and never gave them your email address.",
          "Replies go to the organizer at host@example.org.",
          `Stop receiving messages about this event: ${UNSUBSCRIBE_URL}`,
          `Manage your signup: ${MANAGE_URL}`,
          "civfix.org",
        ].join("\n"),
      ].join("\n\n"),
    )
  })

  it("keeps the critical footer text byte-identical and without an unsubscribe link", () => {
    const { text, html } = render(
      eventFooter({ eventTitle: "Beach", critical: true, unsubscribeUrl: UNSUBSCRIBE_URL }),
    )

    expect(
      text.endsWith(
        [
          'This is a service message about "Beach", an event you signed up for on civfix. ' +
            "You receive these even if you have turned off updates from this organizer.",
          "Replies to this address are not monitored.",
          "civfix.org",
        ].join("\n"),
      ),
    ).toBe(true)
    expect(html).not.toContain("unsubscribe")
  })
})

describe("plain string footers", () => {
  it("never links a URL inside free text", () => {
    const { html } = render(`Organizer says hi ${LURE_URL}`)

    expect(html).not.toContain("<a ")
    expect(html).toContain(LURE_URL)
  })
})
