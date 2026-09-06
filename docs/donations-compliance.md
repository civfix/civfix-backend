# Donations compliance map

How each legal obligation in the donations surface is met **in shipped code**, which test pins it, and
what is still a human obligation rather than a code one.

This is an engineering map, not legal advice. Every rule below traces to the research memo in the W4
plan (D13), which is itself explicitly "verify with counsel". Where a rule is not yet satisfied it says
so out loud.

---

## 1. Architecture, in one paragraph

Charges are **direct charges on the organization's own Stripe connected account**. The organization is
the merchant of record; civfix never holds the funds and never touches a card number. civfix takes a
disclosed `application_fee` on top. This is what makes the money-transmission and escrow questions
structurally simple, and it is why there is deliberately **no refund API** on the civfix side: an
organization refunds from its own dashboard and civfix only reacts.

---

## 2. Rule → code path → test

| Obligation | Code path | Test |
| --- | --- | --- |
| Gov. Code §12599.9(e) donation-page disclosures are server-authored and versioned | `donation-service.ts` `publicPage()` builds `disclosures` + `disclosureVersion` from data; nothing is org-authored except the mission blurb, designation note and refund policy | `checkout.test.ts` "serves server-authored disclosures…" |
| Never claim "100% goes to the charity" (§314(d)) | fee itemization is always present in `disclosures.feePointer` and `feePreview` | `checkout.test.ts` "never claims that 100%…" |
| §317 donor-sharing is opt-in, default OFF | `DonorSharingPolicy.defaultOn` is the literal `false`; `donations.share_identity_with_org` defaults false; org reads and the CSV blank the identity unless it is true | `checkout.test.ts`, `donation-export-builder.ts` provenance, `donation-service.ts` `toOrgDonationRowDto` |
| §316 good-standing gate at AUTHORIZATION time | checkout refuses unless the verdict is `eligible`/`grace` AND the evidence is fresher than `ELIGIBILITY_STALE_GRACE_HOURS`; the verdict is frozen into `donations.eligibility_snapshot` | `checkout.test.ts` refusal arms |
| CA AG "May Not Operate or Solicit" is a hard gate with a 5-business-day grace | `@civfix/shared/payments` `evaluateEligibility` + `eligibility-service.ts`; MNOS import runs `0 17 * * 3` and is a no-op on an unchanged revision | `eligibility.test.ts` grace window |
| Reinstated organizations are never naive-blocked | `evaluateEligibility` treats auto-revocation + Pub 78 as eligible | `eligibility.test.ts` "keeps a REINSTATED organization eligible" |
| Group-exemption subordinates get no reliance | ineligible until `central_org_confirmed_at` is set | `eligibility.test.ts` |
| OFAC never auto-blocks | the SDN screen is a NAME match (`normalizeOrgName`, exact after normalization) against the IRS legal name and the org name; a hit is `matched=true, neutral` evidence and the verdict becomes `review_required`, which by policy (`REVIEW_REQUIRED_BLOCKS_DONATIONS = false` in `@civfix/shared/payments`) keeps donations on and renders `AT_RISK`; counsel flips the constant to block, and operators see it as `reviewRequiredBlocks` on the platform settings | `eligibility.test.ts` OFAC cases, `org-payments.test.ts` AT_RISK |
| The EIN civfix screens under has a recorded provenance | copied from the approved `org_verifications` application into `org_eligibility.ein` INSIDE the approval transaction (`decideVerificationTx` → `upsertOrgEligibilityEin`; `ein_source='org_verification'`, `ein_set_by`, `ein_set_at`; migration 0156) — approval and EIN copy are both-or-neither, and the post-commit evaluation enqueue is best-effort and logged; operators may set/correct it (`ein_source='operator'`, audited); an EIN change resets the verdict to `unknown` and evidence for the old EIN is never read again | `organization-service.test.ts` "copies a verified nonprofit's EIN", `eligibility-admin.test.ts`, `eligibility.test.ts` "resets the verdict" |
| Deductibility is a property of the exemption evidence, never of the verdict | `EligibilityResult.contributionsDeductible` (Pub 78 listing or a deductible BMF code, false whenever disqualified) is persisted as `org_eligibility.contributions_deductible` and is the ONLY thing the receipt and the donate page read; an OFAC review flag does not change it, and no `eligible\|grace` literal remains in application code | shared `eligibility.test.ts` "derives deductibility", `receipt.test.ts` |
| An OFAC review can never stand in for a positive listing | the predicate checks Pub 78 / BMF BEFORE the SDN flag: an unlisted organization with a name collision stays `unknown` (reasons `[…, ofac_sdn_match]`), so `review_required` — which by policy permits donations — is reachable only from an otherwise eligible state | shared `eligibility.test.ts` "never lets an OFAC review stand in", backend "flags an OFAC name match" |
| No false evidence: a list revision that cannot be parsed is never "not listed" | per-source decoders (ZIP + pipe for IRS Pub 78 / Auto-Revocation, all four EO BMF regions by header name, header-guarded FTB / MNOS, OFAC `sdn.csv`) plus a sanity floor (`minRows` per source AND >= 90 % of rows decoding) — a failing revision ABORTS before any archive, evidence or verdict write | `eligibility.test.ts` "ABORTS" cases |
| Rev. Proc. 2018-32 §8.01 evidence schema, append-only | `org_eligibility_checks` (0147) with `source, ein, irs_legal_name, foundation_code, deductibility_code, source_revision_date, raw_report_sha256, raw_report_key, matched, verdict_contribution, checked_at, retention_until`; the published list itself is archived under `compliance/<source>/<revision>.raw` | `eligibility.test.ts` "evidence is append-only" (a SOURCE-TEXT assertion that no `UPDATE org_eligibility_checks` exists) |
| Receipts within 5 business days (§319) | `donation.receipt` is enqueued the moment a donation succeeds, retried 5 times, and re-enqueued by `donation.retention.sweep`; `civfix_donation_receipts_pending > 6h` alerts | `fulfill.test.ts`, `receipt.test.ts` |
| Receipt content: B&P §17510.3 deductibility statement incl. percentage | `receiptStatements().deductibility` | `receipt.test.ts` |
| Receipt content: IRC §170(f)(8) CWA at $250+ | `CWA_THRESHOLD_MINOR` + `requiresCwa` | `receipt.test.ts` |
| Contribution date = card charge date | `donations.charged_at` is set from the Stripe charge and is the ONLY date printed | `fulfill.test.ts` "uses the CHARGE date", `receipt.test.ts` |
| civfix issues the receipt as the charity's authorized agent (§318(a)(9)) | `receiptStatements().agent` | `receipt.test.ts` |
| CAN-SPAM: zero promotional content in a receipt | `Auto-Submitted: auto-generated`, no `List-Unsubscribe`, no marketing copy | `receipt.test.ts` "carries NO List-Unsubscribe…" |
| §318 versioned agreement with each charity + change log | `org_donation_settings.consent_agreement_version` + `org_donation_agreement_changes` + a `consent_records` row | `org-payments.test.ts` agreement tests |
| Clickwrap consent evidence (document + version + sha256 + surface) | `consent_records` (0151) written INSIDE the donation transaction; the server stamps `accepted_at` from its own clock and validates the versions against `LEGAL_DOCUMENTS` (409 on drift) | `checkout.test.ts` 409 arm, `payments-pg.test.ts` |
| Fee itemization on the receipt (gross / processor / civfix / net) | `donation-receipt-pdf.ts` "How the amount was applied" | `receipt.test.ts` |
| Fee refundability: civfix returns its fee proportionally | `syncRefunds()` proportional `refundApplicationFee` | `fulfill.test.ts` refund math |
| A platform fee increase cannot be applied by editing a secret | checkout charges `min(env DONATION_PLATFORM_FEE_BPS, agreed_fee_bps)` | `checkout.test.ts` "never charges above the agreed rate" |
| PCI: no card data ever reaches civfix | only `card_brand` + `card_last4` are stored; the classifier never reads `err.raw`; `PAN_RE` scrubs any long digit run out of an error message | `payment-failure.test.ts`, `redaction.test.ts` |
| Financial records retained 7 years, OFAC 10 | `donations.retention_until = charged_at + 7y`; per-row `retention_until` on evidence | `payments-pg.test.ts` retention |
| Erasure keeps the financial record | `softDeleteAndAnonymize` NULLs `donations.user_id` and stamps `profile_unlinked_at`; contact goes at 7 years | `payments-pg.test.ts` erasure |

---

## 3. The §8.01 evidence schema, as stored

`org_eligibility_checks` is **append-only**. A row is never updated and is only removed by its own
`retention_until` (7 years, 10 for OFAC). `eligibility_source_revisions` records which published
revision was consulted, its sha256 and the archived object key, so a verdict can be reconstructed
exactly as it stood on the day a donation was authorized.

The archived raw report is deleted **before** its revision row, so a surviving row never names a
missing object.

### 3.1 Bootstrap, screening targets and on-demand evaluation

- **Targets** are every verified nonprofit organization with an EIN (`org_eligibility` joined to
  `organizations`), not Stripe-connected ones — connecting requires a verdict, so the verdict has to
  come first.
- **Bootstrap**: approving a nonprofit verification copies the application's EIN into
  `org_eligibility` (`onNonprofitVerified` hook → `eligibility-bootstrap.ts`) and queues
  `eligibility.evaluate`. An application without a usable EIN is logged; an operator sets the EIN
  from the admin eligibility queue (`POST /admin/orgs/:id/payments/eligibility/ein`).
- **Evaluate = screen + compute.** `evaluate` first screens the organization against the LATEST
  ARCHIVED revision of every source it has not yet been checked against (the archived object is read
  back from `compliance/<source>/<revision>[.partN].raw`), appends the resulting rows, then runs the
  shared predicate. A newly bootstrapped organization therefore gets a real verdict within minutes,
  not on the next monthly import. Operators can trigger it
  (`POST /admin/orgs/:id/payments/eligibility/evaluate`).
- **Group-exemption subordinates** are detected from the EO BMF `AFFILIATION = 9` column and stay
  `ineligible` until an operator records the central organization's confirmation
  (`POST /admin/orgs/:id/payments/eligibility/central-org`), which is itself an append-only
  `central_org_confirmation` evidence row.
- **Auto-revocation with a reinstatement date** is stored as `matched=true, neutral` — evidence in
  both directions, never disqualifying (D13: reinstated organizations stay on that list forever).
- **`unknown` with reason `positive_sources_not_yet_checked`** means no Pub 78 / BMF screening has run
  for this EIN yet (remediation: evaluate-now or wait for the import); `no_positive_listing` means
  the screening ran and found nothing.
- **Fail closed on a broken archive.** If any source's archived revision cannot be read back during
  screening, `evaluate` throws `EligibilityScreeningError` BEFORE writing a verdict, so the job
  retries and alerts instead of disabling donations on partial evidence.
- **Revision drift.** Besides the row floor and the 90 % decode ratio, an import aborts
  (`revision_drift`) when a revision holds fewer than half the rows of the last archived one for that
  source; a genuinely shrunk list is a deliberate, code-level floor change, not something a cron
  should accept on its own.
- **Scheduling.** pg-boss keeps exactly one schedule per queue name, so each source imports on its
  own queue (`eligibility.import.<source>`), all created with the shared `short` policy.
- **Known follow-ups** (not defects in the evidence): the import buffers every part of a revision in
  memory before the floor check (the four EO BMF regions together are several hundred MB inside the
  API process — verify `ELIGIBILITY_MAX_BYTES` against the real `eo*.csv` sizes before the first live
  run); evaluate-now re-scans the full archived revision for one organization (a per-revision EIN index
  would make it a lookup); OFAC screens `sdn.csv` names only (no `alt.csv` aliases) and the
  organization's name at bootstrap time; `applyVerdict` keeps the last IRS name/codes on
  `org_eligibility` after a delisting (history for the operator view; the verdict, not those fields,
  gates anything).
- **Revision identity**: the revision date is the newest `Last-Modified` across a source's files; a
  multi-file source (EO BMF) records the sha256 of the concatenated per-file digests and a
  `compliance/<source>/<revision>` prefix, and each matched row names the exact part it was found in.

⚠ The media-worker orphan sweep must never reap `receipts/` or `compliance/`. Both prefixes hold
objects referenced by rows in tables the worker does not know about.

---

## 4. Stripe artifact checklist (per environment)

- [ ] Restricted key `rk_…` scoped to payments + connect (an `sk_` is refused at boot)
- [ ] Two webhook endpoints with DIFFERENT secrets: `/webhooks/stripe/connect` and
      `/webhooks/stripe/platform` (one shared secret is refused at boot)
- [ ] Connect settings: platform profile, statement descriptor, branding
- [ ] `payment_method_domains` registered per connected account for Apple Pay / Google Pay
- [ ] Written 6.4.3 / 11.6.1 TPSP confirmation downloaded from the Stripe compliance documents page
- [ ] Staging uses its OWN Stripe sandbox, its own `rk_`/`whsec_`, its own test connected accounts and
      its own publishable key — this is a deliberate exception to "staging reuses prod vendor creds"

---

## 5. Counsel register — open, not code

1. **CA AG Form PL-1 registration filed and effective before the first solicitation.** PL-2 renewal
   (Jan 15) and PL-4 report (Jul 15) calendared. Nothing in code checks this; `PAYMENTS_ENABLED`
   staying `false` is the control.
2. **Stripe underwriting pre-approval** — charitable fundraising is a restricted category.
3. **The 5% platform fee** — multistate charitable-solicitation and UBIT implications. If counsel says
   no, set `DONATION_PLATFORM_FEE_BPS=0` and the adapter omits the fee parameter entirely. Zero code
   change.
4. **PCI SAQ A + quarterly ASV scans** — required even with fully outsourced payment pages.
5. **`DEFAULT_DEDUCTIBLE_BMF_CODES`** is deliberately the conservative `["1"]` because the Pub 78
   deductibility code set is listed as unverified in the research. It is injectable; confirm the real
   set before the first live donation.
6. **The MNOS grace window skips weekends only** — federal holidays are not modelled, which errs on
   the conservative side (it shortens the grace). Confirm that is acceptable.
7. **Whether Stripe automatically reverses the application fee on a disputed direct charge** is
   UNVERIFIED. The code attempts an idempotent fee refund and tolerates an already-refunded fee as
   `skipped`; sandbox-verify with test card `4000000000000259`.
8. **Cookie commitment** — Stripe.js sets `__stripe_mid` / `__stripe_sid`. The cookies page currently
   says civfix sets no third-party cookies. That statement has to change before the donor surface
   ships.
9. **`LEGAL_DOCUMENTS.sha256` are placeholders** — they are hashes of `"<type>@<version>"`, not of any
   published page. A consent record is only meaningful once they are the real content hashes.
10. **Long-retention backups.** Today's backup lane is hourly/daily with roughly 7 days of history and
    a delete-capable token. Seven years of financial record cannot be restored from that.

---

## 6. What the code refuses to do

- It will not take money while `PAYMENTS_ENABLED` is false — `DisabledPayments` throws
  `PAYMENT_UNAVAILABLE` from every method, so a misconfigured process refuses rather than falling back
  to a fake.
- It will not take money for an organization that is not `READY`, and it answers 404 rather than
  publishing a negative compliance judgement about a named charity on a public URL.
- It will not delete a donation. Not on account deletion, not on organization deletion (RESTRICT), not
  in any retention lane.
- It will not refund a donation. There is no civfix code path that moves money back to a donor.
- It will not log a Stripe error's `raw` object, and it never puts a card number in an error message.

---

## 7. Money-correctness decisions from the round-2 review

- **A refund that later fails stops counting.** `donation_refunds` rows are upserted with their
  current Stripe status (`ON CONFLICT (id) DO UPDATE`), `refundedTotalOf` sums only rows whose status
  is not `failed`/`canceled`, and `applyRefundTotals` SETS the recomputed total rather than ratcheting
  it. The donation status is re-derived from that total by `refundedDonationStatus`
  (`@civfix/shared/payments/donation-state.ts`), which is allowed to walk a settled donation BACK
  (`refunded → partially_refunded → succeeded`) and never touches a `pending`/`failed` one.
  `advanceStatus` still governs every forward move (fulfilment, disputes); this is the single
  deliberate backward correction, and it is logged at error level via `isRefundStatusCorrection`.
- **The application fee is never un-refunded.** civfix returns its proportional fee as soon as a
  refund is recorded, including a `pending` one. Stripe has no reversal for an application-fee refund,
  so when the underlying refund later fails the row is marked `app_fee_refund_state='failed_after'`
  (migration 0160) and an error is logged naming the donation and organization. Nothing is retried and
  nothing is auto-reversed: the fee is recovered by hand or written off. `failed_after` is outside the
  `('pending','failed')` retry predicate by design.
- **One donation owns exactly one Checkout Session.** An idempotency replay never calls
  `checkout.sessions.create` again. A replay whose donation is not `pending` is a 409; a pending
  replay with a session id retrieves that session through the seam
  (`Payments.retrieveCheckoutSession`) and returns its live `client_secret`, or 409s when the session
  is no longer open. The `client_secret` is deliberately NOT persisted: it is a bearer capability for
  the session, and Stripe already holds it.
- **`deauthorized` is recoverable.** Connecting a payout account for an organization whose row is
  `deauthorized` first re-reads the existing account: if Stripe reports `charges_enabled` the org
  re-authorized civfix itself, so `deauthorized_at` and the `deauthorized` donations disable are
  cleared. Otherwise a NEW connected account is created under idempotency key
  `acct:<org>:v2:<attempt>` (`org_stripe_accounts.reconnect_attempts`, migration 0161), the row is
  relinked (old id appended to `previous_stripe_account_ids`, payment-method domains reset,
  `deauthorized_at` cleared so the sync sweep can see it again) and donations stay disabled with
  reason `deauthorized` until a later `syncAccount` proves `charges_enabled` on the new account.
- **Reconciliation never advances past what it compared.** The local side is paged to exhaustion
  (bounded by `RECONCILE_MAX_DONATION_PAGES`); when that bound is hit the Stripe transactions newer
  than the last local donation are excluded from the comparison and `reconciled_through` is capped at
  that donation's `charged_at`. The window ends at `now − RECONCILE_SETTLE_LAG_MS` (1 h) so a charge
  whose fulfilment lands after the run is still inside the next window.
- **Migration numbering.** `0155` is unused and will stay unused — the payments slice took
  `0145`–`0154`, `0156`, `0160` and `0161`; `0157`–`0159` belong to the host-comms slice. Migrations apply
  in lexical order and the runner records each file it applied, so a gap is inert.
