import { describe, expect, it } from "vitest"
import { CfInboundMail } from "../../src/adapters/inbound-mail.cf.js"
import { cityReplyChatBody } from "../../src/services/admin/inbound-thread-correlation.js"
import { htmlToText } from "../../src/services/admin/mail-preview.js"

const ADDR = "report-b42poxxswvjo@civfix.org"
const OUT_ID = "<out-f60fdbd0-3755-4365-a1b5-1a5e238bcc00@civfix.org>"
const PACKET = "> A resident reported a Trash issue in Testville through civfix."

function reply(...quoted: string[]): string {
  return ["Crew en route.", "", ...quoted, "", PACKET, "> Location: 100 Test St"].join("\n")
}

describe("cityReplyChatBody: quoted history in every client's shape", () => {
  it.each([
    ["Gmail, wrapped", reply("On Tue, Sep 22, 2026 at 8:47 PM civfix Reports <", `${ADDR}> wrote:`)],
    ["Gmail, wrapped twice", reply("On Tue, Sep 22, 2026 at 8:47 PM", "civfix Reports", `<${ADDR}> wrote:`)],
    ["Apple Mail", reply(`On Sep 22, 2026, at 8:47 PM, civfix Reports <${ADDR}> wrote:`)],
    ["Gmail es", reply(`El mar, 22 sept 2026 a las 20:47, civfix Reports (<${ADDR}>) escribió:`)],
    ["Gmail de, wrapped", reply("Am Di., 22. Sept. 2026 um 20:47 Uhr schrieb civfix Reports <", `${ADDR}>:`)],
    ["Gmail ko", reply(`2026년 9월 22일 (화) 오후 8:47, civfix Reports <${ADDR}>님이 작성:`)],
    ["Apple Mail ko", reply(`2026. 9. 22. 오후 8:47, civfix Reports <${ADDR}> 작성:`)],
    ["Outlook", reply("________________________________", `From: civfix Reports <${ADDR}>`, "Sent: Tuesday")],
    ["Outlook es", reply("________________________________", `De: civfix Reports <${ADDR}>`, "Enviado: martes")],
    ["an unknown locale", reply(`2026年9月22日(火) 20:47 civfix Reports <${ADDR}>:`)],
    ["a header block with our Message-ID", reply(`In-Reply-To: ${OUT_ID}`, "Subject: couch")],
  ])("%s: publishes only the reply", (_client, body) => {
    expect(cityReplyChatBody(body)).toBe("Crew en route.")
  })

  it("never publishes a reply address or outbound Message-ID, whatever surrounds it", () => {
    const body = `Noted.\nSee ${ADDR.toUpperCase()} for more\n\nThanks`
    expect(cityReplyChatBody(body)).toBe("Noted.")
    expect(cityReplyChatBody(`Ref ${OUT_ID.slice(1, -1)}`)).toBeNull()
  })

  it("matches reply addresses on the configured reply domain only", () => {
    const body = "Write to report-potholes@testville.gov.\nreply-abcdefgh23@civfix.dev"
    expect(cityReplyChatBody(body)).toBe(body)
    expect(cityReplyChatBody(body, "civfix.dev")).toBe("Write to report-potholes@testville.gov.")
  })

  it("keeps a top-posted reply's inline links and an address-less two-line 'On … wrote:'", () => {
    const top = "Tracked at <https://testville.gov/t/4821>\nOn Monday the crew\nwrote:\n- curb cleared"
    const attribution = `On Tue, Sep 22, 2026 at 8:47 PM civfix <${ADDR}> wrote:`
    expect(cityReplyChatBody(`${top}\n\n${attribution}\n${PACKET}`)).toBe(top)
  })

  it.each([
    ["On it.", `On Tue, Sep 22, 2026 at 8:47 PM civfix Reports <\n${ADDR}> wrote:`],
    ["On it.", `On Tue, Sep 22, 2026 at 8:47 PM civfix Reports <${ADDR}> wrote:`],
    ["On it.\nCrew will come tomorrow.", "On Tue, Sep 22, 2026 at 8:47 PM Clerk <clerk@testville.gov> wrote:"],
    ["El camión pasará mañana.", `El mar, 22 sept 2026 a las 20:47, civfix Reports (<${ADDR}>) escribió:`],
    ["Am Mittwoch kommt der Wagen.", `Am Di., 22. Sept. 2026 um 20:47 Uhr schrieb civfix Reports <${ADDR}>:`],
    ["Bonjour,\nLe camion passera demain.", `Le mar. 22 sept. 2026 à 20:47, civfix Reports <${ADDR}> a écrit :`],
  ])("keeps reply text that opens like an attribution right above one: %j", (text, attribution) => {
    expect(cityReplyChatBody(`${text}\n${attribution}\n> x`)).toBe(text)
  })
})

function htmlMail(html: string): Uint8Array {
  const headers = [`From: Clerk <clerk@testville.gov>`, `To: ${ADDR}`, `In-Reply-To: ${OUT_ID}`]
  return new TextEncoder().encode(
    [...headers, "MIME-Version: 1.0", "Content-Type: text/html; charset=UTF-8", "", html].join("\r\n"),
  )
}

async function publishedFromHtml(html: string): Promise<string | null> {
  const mail = await new CfInboundMail().parse(htmlMail(html))
  expect(mail.text).toBeNull()
  return cityReplyChatBody(htmlToText(mail.html ?? ""))
}

describe("cityReplyChatBody: HTML-only replies go through htmlToText, not mailparser's text", () => {
  it("Gmail: drops the wrapped attribution, the blockquote and the tracking pixel", async () => {
    const out = await publishedFromHtml(
      `<div dir="ltr">Crew en route.</div><br><div class="gmail_quote"><div class="gmail_attr">On Tue, Sep 22, 2026 at 8:47 PM civfix Reports &lt;<a href="mailto:${ADDR}">${ADDR}</a>&gt; wrote:<br></div><blockquote class="gmail_quote">A resident reported a Trash issue.</blockquote></div><img src="https://tracker.example/pixel.gif">`,
    )
    expect(out).toBe("Crew en route.")
  })

  it("Outlook: cuts at the divRplyFwdMsg header block and its rule", async () => {
    const out = await publishedFromHtml(
      `<div>Pickup&nbsp;scheduled&#8212;Tuesday.</div><hr><div id="divRplyFwdMsg"><b>From:</b> civfix Reports &lt;${ADDR}&gt;<br><b>Sent:</b> Tuesday<br></div><div>A resident reported a Trash issue.</div>`,
    )
    expect(out).toBe("Pickup scheduled—Tuesday.")
  })

  it("Apple Mail: keeps inline links and drops an unattributed trailing blockquote", async () => {
    const out = await publishedFromHtml(
      `<div>Tracked as <a href="https://testville.gov/t/4821">ticket 4821</a>.</div><blockquote type="cite"><div>A resident reported a Trash issue.</div></blockquote>`,
    )
    expect(out).toBe("Tracked as ticket 4821 (https://testville.gov/t/4821).")
  })

  it("pre-formatted: keeps the <pre> line breaks so an address-less attribution still cuts", async () => {
    const pre = "Crew en route.\n\nOn Tue, Sep 22, 2026 at 8:47 PM civfix Reports wrote:\n> A resident reported a Trash issue.\n> Location: 100 Test St"
    expect(await publishedFromHtml(`<pre>${pre}</pre>`)).toBe("Crew en route.")
  })
})
