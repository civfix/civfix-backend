import { mkdirSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { renderOtp, renderTemplate } from "../src/adapters/mailer.oci.js"
import { renderBroadcast } from "../src/services/host/broadcast-render.js"
import {
  buildDiscussionForwardPacket,
  buildEventPacket,
  buildReportPacket,
} from "../src/services/admin/mail-format.js"
import { buildConfirmationEmail, buildNotificationEmail } from "../src/routes/forms.routes.js"
import { buildDataExportEmail } from "../src/services/data-export-service.js"
import {
  orgInviteEmailVars,
  orgVerificationDecisionEmailVars,
} from "../src/services/host/organization-service.js"
import { teamInviteEmailVars } from "../src/services/host/host-team-service.js"
import type { AdminReportRecord } from "../src/services/admin/admin-report-repository.js"

interface GalleryEntry {
  name: string
  label: string
  subject: string
  html: string
  text: string
}

const WEB = "https://civfix.org"
const EVENT_TITLE = "Ballona Creek Cleanup"
const EVENT_WHEN = "Saturday, October 3 at 9:00 AM PDT"
const EVENT_WHERE = "Ballona Creek Trailhead, 13500 Jefferson Blvd, Los Angeles"
const CANCEL_URL = `${WEB}/guest?token=k3v9pT2wXane4Yr8LqZs0dHc7fGbJmQu`
const UNSUB_URL = `${WEB}/v1/broadcasts/unsubscribe?t=9fJ2mQx7Lw4TzAb1`

function sampleReport(): AdminReportRecord {
  return {
    id: "11111111-2222-3333-4444-555555555555",
    category: "graffiti",
    status: "submitted",
    flagged: false,
    title: "Tagging on the Jefferson Blvd underpass",
    place: "Del Rey",
    reporter: {
      id: "u1",
      name: "Dana Reporter",
      handle: "dana",
      emailVerified: true,
      hasOauth: false,
      joinedAt: new Date("2025-01-01T00:00:00Z"),
    },
    confirmations: 3,
    address: "13500 Jefferson Blvd",
    desc: "Fresh tags along the north wall of the underpass.\nAbout 20 feet of coverage, appeared this week.",
    lat: 33.9812,
    lng: -118.4185,
    hasPhoto: true,
    previewMedia: null,
    createdAt: new Date("2026-09-01T17:20:00Z"),
    referenceCode: "LA-4F7K2",
    verificationVerdict: null,
    verifiedAt: null,
    reporterReportVerified: null,
  }
}

function collect(): GalleryEntry[] {
  const entries: GalleryEntry[] = []
  const push = (
    name: string,
    label: string,
    r: { subject: string; html?: string; text: string },
  ): void => {
    entries.push({
      name,
      label,
      subject: r.subject,
      html: r.html ?? `<pre>${r.text}</pre>`,
      text: r.text,
    })
  }

  push("signin-otp", "Sign-in passcode (Mailer.sendOtp)", renderOtp("482913", "en"))

  push(
    "guest-otp",
    "Guest RSVP code (template guest_otp)",
    renderTemplate("guest_otp", { title: EVENT_TITLE, code: "738201", minutes: "5" }),
  )

  push(
    "guest-confirmed",
    "Guest RSVP confirmation (template guest_confirmed)",
    renderTemplate("guest_confirmed", {
      title: EVENT_TITLE,
      when: EVENT_WHEN,
      place: EVENT_WHERE,
      cancelUrl: CANCEL_URL,
    }),
  )

  push(
    "guest-promoted",
    "Guest waitlist promotion (template guest_promoted)",
    renderTemplate("guest_promoted", {
      title: EVENT_TITLE,
      when: EVENT_WHEN,
      eventUrl: `${WEB}/cleanups/e7a1c9d2-5b34-4f68-9a21-8c3d5e7f0a1b`,
    }),
  )

  push(
    "org-invite",
    "Organization member invite (template action)",
    renderTemplate(
      "action",
      orgInviteEmailVars({
        inviterName: "Maria Chen",
        orgName: "Ballona Creek Trust",
        role: "admin",
        link: `${WEB}/manage/org-invites/accept#token=q8Zw2Xv7Kp4Nr9Ty`,
      }),
    ),
  )

  push(
    "org-verification-approved",
    "Org verification approved (template action)",
    renderTemplate(
      "action",
      orgVerificationDecisionEmailVars({
        orgName: "Ballona Creek Trust",
        kindLabel: "nonprofit",
        approved: true,
        reason: "",
        orgUrl: `${WEB}/orgs/ballona-creek-trust`,
        verifyUrl: `${WEB}/manage/orgs/1/verification`,
      }),
    ),
  )

  push(
    "org-verification-rejected",
    "Org verification rejected (template action)",
    renderTemplate(
      "action",
      orgVerificationDecisionEmailVars({
        orgName: "Ballona Creek Trust",
        kindLabel: "nonprofit",
        approved: false,
        reason:
          "The determination letter you uploaded names a different legal entity than the organization profile.",
        orgUrl: `${WEB}/orgs/ballona-creek-trust`,
        verifyUrl: `${WEB}/manage/orgs/1/verification`,
      }),
    ),
  )

  push(
    "team-invite",
    "Event team invite (template action)",
    renderTemplate(
      "action",
      teamInviteEmailVars({
        title: EVENT_TITLE,
        role: "co-host",
        link: `${WEB}/cleanups/e7a1c9d2#teamInvite=m2Pq8Rv5Tx7Zw1Ka`,
      }),
    ),
  )

  push(
    "generic-fallback",
    "Generic fallback (template generic)",
    renderTemplate("generic", {
      subject: "A civfix notification",
      message: "You have a new civfix notification.",
    }),
  )

  const announcement = renderBroadcast(
    {
      subject: "This Saturday: {event_title} - what to bring",
      bodyMd:
        "Hi {first_name},\n\n" +
        "We are all set for {event_when} at the trailhead. A few notes before the day:\n\n" +
        "- We provide grabbers, gloves and bags\n" +
        "- Wear closed-toe shoes and bring a refillable water bottle\n" +
        "- Parking is free in the lot off Jefferson after 8:30 AM\n\n" +
        "**Meet at the blue canopy** near the bike path entrance. See the full plan at [the event page](https://civfix.org/e/ballona-creek-cleanup).",
      ctaLabel: "View event details",
      ctaUrl: `${WEB}/e/ballona-creek-cleanup`,
    },
    {
      eventTitle: EVENT_TITLE,
      vars: {
        first_name: "Jordan",
        event_title: EVENT_TITLE,
        event_when: EVENT_WHEN,
        event_where: EVENT_WHERE,
      },
      unsubscribeUrl: UNSUB_URL,
      manageUrl: `${WEB}/e/ballona-creek-cleanup`,
      replyTo: "hosts@ballonacreektrust.org",
    },
  )
  push("broadcast-announcement", "Host announcement (broadcast pipeline)", announcement)

  const critical = renderBroadcast(
    {
      subject: "{event_title} moved to 10:00 AM",
      bodyMd:
        "Hi {first_name},\n\nCity crews are resurfacing the parking lot early Saturday, so we are pushing the start to **10:00 AM**. Same meeting point at the blue canopy. If you can no longer make it, you can cancel from the event page.",
    },
    {
      eventTitle: EVENT_TITLE,
      vars: {
        first_name: "Jordan",
        event_title: EVENT_TITLE,
        event_when: EVENT_WHEN,
      },
      manageUrl: `${WEB}/e/ballona-creek-cleanup`,
      critical: true,
    },
  )
  push("broadcast-event-updated", "Event updated notice (critical broadcast)", critical)

  const form = {
    coachName: "Sam Alvarez",
    role: "Head coach",
    school: "Venice High School",
    city: "Los Angeles",
    teamSize: "18",
    email: "coach.alvarez@venicehigh.edu",
    phone: "(310) 555-0142",
    notes: "Season runs through November; weekday afternoons work best.",
    turnstileToken: "x",
    honeypot: "",
  }
  push(
    "home-turf-notification",
    "Home Turf sign-up (to staff)",
    buildNotificationEmail(form, "no-reply@civfix.org", "events@civfix.org"),
  )
  push(
    "home-turf-confirmation",
    "Home Turf confirmation (to submitter)",
    buildConfirmationEmail(form, "no-reply@civfix.org", "events@civfix.org"),
  )

  push(
    "data-export",
    "Data export ready (DSAR)",
    buildDataExportEmail("support@civfix.org", ["messages", "comments"]),
  )

  push(
    "admin-report-packet",
    "Admin report forward (to city office)",
    buildReportPacket(
      sampleReport(),
      { geoid: "0644000", dept: "Public Works", place: "Los Angeles", contact: null, routed: true },
      [`${WEB}/m/a?t=1`, `${WEB}/m/b?t=2`],
      "Second report at this location this month; residents flagged it as recurring.",
    ),
  )

  push(
    "admin-discussion-forward",
    "Admin discussion forward (to city office)",
    buildDiscussionForwardPacket(
      {
        reportId: "11111111-2222-3333-4444-555555555555",
        category: "graffiti",
        place: "Del Rey",
        org: null,
      },
      "The tags are back again this week - is there a schedule for abatement on this wall?",
    ),
  )

  push(
    "admin-event-packet",
    "Admin event resource request (to city office)",
    buildEventPacket(
      {
        title: EVENT_TITLE,
        host: "Ballona Creek Trust",
        place: "Del Rey",
        address: "13500 Jefferson Blvd, Los Angeles",
        lat: 33.9812,
        lng: -118.4185,
        referenceCode: "LA-4F7K2",
      },
      "We expect around 60 volunteers and would appreciate a dumpster drop-off on Friday plus pickup Monday.",
    ),
  )

  return entries
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
}

function indexHtml(entries: GalleryEntry[]): string {
  const rows = entries
    .map(
      (e) =>
        `<li><a href="./${e.name}.html">${escapeHtml(e.label)}</a><span class="subject">${escapeHtml(e.subject)}</span></li>`,
    )
    .join("\n")
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>civfix email gallery</title>
<style>
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;margin:40px auto;max-width:720px;padding:0 20px;color:#2a2622;}
h1{font-size:22px;}
ul{list-style:none;padding:0;}
li{padding:10px 0;border-bottom:1px solid #e5e0d6;display:flex;flex-direction:column;gap:2px;}
a{color:#3a76a8;text-decoration:none;font-weight:600;}
a:hover{text-decoration:underline;}
.subject{color:#7a7264;font-size:13px;}
</style></head><body>
<h1>civfix email gallery (${entries.length})</h1>
<ul>
${rows}
</ul>
</body></html>`
}

function main(): void {
  const outdirArg = process.argv[2]
  if (outdirArg === undefined || outdirArg.length === 0) {
    console.error("usage: pnpm exec tsx scripts/render-email-gallery.ts <outdir>")
    process.exit(1)
  }
  const outdir = resolve(outdirArg)
  mkdirSync(outdir, { recursive: true })
  const entries = collect()
  for (const entry of entries) {
    writeFileSync(join(outdir, `${entry.name}.html`), entry.html)
  }
  writeFileSync(join(outdir, "index.html"), indexHtml(entries))
  console.log(`wrote ${entries.length} emails + index.html to ${outdir}`)
}

main()
