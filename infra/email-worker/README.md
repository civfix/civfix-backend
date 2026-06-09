# civfix Email Worker

Cloudflare Email Worker that ingests catch-all `*@civfix.org` mail. It **filters** spam / auth
failures, writes the raw `.eml` to **R2** (`inbound/pending/<messageId>.eml` — the source of truth),
and best-effort POSTs an HMAC-signed `{ key }` nudge to the backend webhook. The backend re-fetches
from R2, parses, routes (reply → mail thread; else → inbox), and reconciles `inbound/pending/` on boot
+ a cron sweep, so a missed nudge is never a lost message.

See `documents/17-inbound-email-worker.md` for the full pipeline + enablement guide.

## Layout

Standalone — **not** in the backend pnpm/Turbo workspace (own `wrangler` toolchain).

```
src/index.ts   the email() handler
wrangler.toml  bindings (R2_BUCKET), vars (BACKEND_WEBHOOK_URL), prod/staging envs
test/          vitest unit tests (filter, id derivation, HMAC fixture shared with the backend)
.dev.vars      LOCAL secrets (gitignored); copy from .dev.vars.example
```

## Configure before deploy

1. **`wrangler.toml` → `bucket_name`**: set to the backend's real `R2_BUCKET` value (same physical
   bucket, so the backend sweep sees what the Worker writes).
2. **`BACKEND_WEBHOOK_URL`**: must equal the backend `PUBLIC_API_URL` + `/webhooks/inbound-mail`.
3. **Secret**: `wrangler secret put CF_EMAIL_WEBHOOK_SECRET --env production` — the **same value** the
   backend has for `CF_EMAIL_WEBHOOK_SECRET` (the HMAC key). They must be byte-identical.

## Develop

```sh
pnpm install
cp .dev.vars.example .dev.vars     # set CF_EMAIL_WEBHOOK_SECRET to match your local backend
pnpm dev                           # wrangler dev (local R2 simulation; add --remote to hit the real bucket)
pnpm test                          # unit tests
pnpm typecheck
```

Send a sample message to the local email endpoint (GA Apr 2025):

```sh
curl -X POST 'http://localhost:8787/cdn-cgi/handler/email' \
  --url-query 'from=resident@example.gov' \
  --url-query 'to=support@civfix.org' \
  -H 'Content-Type: application/json' \
  --data-raw 'From: City Clerk <clerk@example.gov>
To: support@civfix.org
Subject: pothole on Main St
Message-ID: <test-001@example.gov>
Authentication-Results: mx.cloudflare.com; spf=pass; dkim=pass; dmarc=pass
Content-Type: text/plain

We received your report.'
```

Expect an `inbound/pending/test-001@example.gov.eml` object and a signed POST to your local backend.
Set `Authentication-Results: ...; dmarc=fail` to exercise the reject path.

## Deploy + enable Email Routing

```sh
pnpm deploy            # wrangler deploy --env production (after `wrangler login` / CLOUDFLARE_API_TOKEN)
```

Then, in the Cloudflare dashboard (or API): enable **Email Routing** on `civfix.org` (auto-manages
MX/TXT and **takes over inbound mail for the domain** — confirm no other inbound provider first), and
set the **catch-all** route Action to **Send to a Worker** → `civfix-inbound-email`. The
`/webhooks/*` path stays un-gated by Cloudflare Access (documents/16), so the Worker can POST it
through the tunnel. Details + the catch-all API call: `documents/17-inbound-email-worker.md`.
