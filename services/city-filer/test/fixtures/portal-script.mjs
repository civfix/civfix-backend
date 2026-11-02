// A test-only portal script for the fixture portal (test/fixtures/portal.ts), written the way a
// workspace script uses the kit.
import { launch, result, screenshot, submit } from "@civfix/filer-kit"

export default async function file(packet) {
  const { page } = await launch()
  await page.goto(packet.startUrl)

  const similar = page.locator("#similar")
  if ((await similar.count()) > 0) {
    const caseId = /SR-\d+/.exec(await similar.innerText())?.[0]
    await screenshot("similar request")
    await result({ outcome: "linked_existing", caseId })
    return
  }
  if ((await page.locator("form").count()) === 0) throw new Error("the report form is missing")

  await page.fill("textarea[name=description]", packet.ticketText)
  await page.fill("input[name=email]", packet.contact.email)
  await screenshot("form")
  await submit(page.locator("#submit"))

  await page.waitForSelector("#case, #error")
  if ((await page.locator("#error").count()) > 0)
    throw new Error("the portal answered with an error")
  await screenshot("confirmation")
  await result({ outcome: "submitted", caseId: (await page.locator("#case").innerText()).trim() })
}
