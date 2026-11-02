// GH#225: every string a notification email prints is catalogued for every server locale, the category
// labels read exactly as D1 names them on the settings screen, and the `report_update` email template,
// which nothing sent, is gone.

import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { NotificationCategorySchema } from "@civfix/contract"
import { en } from "../../src/i18n/messages/en.js"
import { es } from "../../src/i18n/messages/es.js"
import { de } from "../../src/i18n/messages/de.js"
import { ko } from "../../src/i18n/messages/ko.js"
import { renderTemplate } from "../../src/adapters/mailer.oci.js"

const CATALOGS: Record<string, Record<string, string | undefined>> = { en, es, de, ko }

const EMAIL_KEYS = [
  "email.notification.open_cta",
  "email.notification.conversation_subject",
  "email.notification.footer_reason",
  "email.notification.footer_stop",
  "email.notification.footer_manage",
] as const

const D1_LABELS: Record<string, string> = {
  reportUpdates: "Updates on your reports",
  reportDiscussions: "Report discussions",
  directMessages: "Direct messages",
  mentions: "Mentions and replies",
  groupChats: "Group chats",
  events: "Events you're going to",
  hostAnnouncements: "Announcements from hosts",
  eventTeam: "Event team and hours",
  followers: "New followers",
  likesAndReposts: "Likes and reposts",
  organizations: "Organizations",
}

describe("notification email copy", () => {
  it("T45: every locale has the eleven category labels and every email string, and en's labels are D1's", () => {
    const categories = NotificationCategorySchema.options
    expect(categories).toHaveLength(11)
    for (const [locale, catalog] of Object.entries(CATALOGS)) {
      for (const category of categories) {
        const label = catalog[`notification.category.${category}`]
        expect(label, `${locale} ${category}`).toEqual(expect.any(String))
        expect(label!.length, `${locale} ${category}`).toBeGreaterThan(0)
      }
      for (const key of EMAIL_KEYS) {
        expect(catalog[key], `${locale} ${key}`).toEqual(expect.any(String))
      }
    }
    for (const category of categories) {
      expect(en[`notification.category.${category}` as keyof typeof en]).toBe(D1_LABELS[category])
    }
  })

  it("T46: no report_update template renderer and no email.report_update key in any locale", () => {
    const source = readFileSync(
      fileURLToPath(new URL("../../src/adapters/mailer.oci.ts", import.meta.url)),
      "utf8",
    )
    expect(source).not.toContain("report_update")
    expect(source).not.toContain("renderReportUpdate")
    for (const [locale, catalog] of Object.entries(CATALOGS)) {
      const stale = Object.keys(catalog).filter((key) => key.startsWith("email.report_update."))
      expect(stale, locale).toEqual([])
    }
    const generic = renderTemplate("report_update", { status: "resolved" })
    expect(generic.subject).toBe("A civfix notification")
  })
})
