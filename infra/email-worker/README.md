# civfix Email Worker

Cloudflare Email Worker that ingests catch-all `*@civfix.org` mail. It writes the raw `.eml` to
**R2** (`inbound/pending/<messageId>.eml` — the source of truth) and best-effort POSTs an HMAC-signed
`{ key }` nudge to the backend webhook. The backend re-fetches from R2, parses, routes (reply → mail
thread; else → inbox), and reconciles `inbound/pending/` on boot + a cron sweep, so a missed nudge is
never a lost message.

The Worker does **not** judge sender authentication. `message.headers` does not expose the
`Authentication-Results` header Cloudflare stamps (workerd#6740), so a header check here never fired.
The backend is the only gate: it reads the top-most `Authentication-Results` in the raw message and
trusts it only when its authserv-id is `mx.cloudflare.net`.

What the backend does with a message, and which messages may publish into a report chat, is in
`docs/inbound-mail-effects.md`.

## Topology

| | Production | Staging |
|---|---|---|
| Mail domain (MX → Cloudflare Email Routing) | `civfix.org`, catch-all → Worker | `civfix.dev`: no MX, no routing rule |
| Worker (`wrangler.toml` env) | `civfix-inbound-email` | `civfix-inbound-email-staging` |
| R2 bucket the Worker writes | `civfix-emails` | `civfix-emails-staging` |
| Backend nudge target | `https://api.civfix.org/webhooks/inbound-mail` | `https://api.civfix.dev/webhooks/inbound-mail` |

The backend reads the same bucket through `R2_INBOUND_BUCKET`, which must differ from the media bucket
`R2_BUCKET` and is required whenever `R2_PUBLIC_BASE` is set (`services/api/src/env.ts`). The reply
addresses outbound mail advertises live on `MAIL_REPLY_DOMAIN` (default `civfix.org`).

## Layout

Standalone — **not** in the backend pnpm/Turbo workspace (own `wrangler` toolchain).

```
src/index.ts   the email() handler
wrangler.toml  bindings (R2_BUCKET), vars (BACKEND_WEBHOOK_URL), prod/staging envs
test/          vitest unit tests (id derivation, HMAC fixture shared with the backend)
.dev.vars      LOCAL secrets (gitignored); copy from .dev.vars.example
```

## Configure before deploy

1. **`wrangler.toml` → `bucket_name`**: set to the backend's `R2_INBOUND_BUCKET` value, so the
   backend sweep sees what the Worker writes. Never the media bucket `R2_BUCKET`.
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
Authentication-Results: mx.cloudflare.net; spf=pass; dkim=pass header.d=example.gov; dmarc=pass header.from=example.gov
Content-Type: text/plain

We received your report.'
```

Expect an `inbound/pending/test-001@example.gov.eml` object and a signed POST to your local backend.

## Deploy + enable Email Routing

```sh
pnpm run deploy          # wrangler deploy --env production
pnpm run deploy:staging  # wrangler deploy --env staging (after `wrangler login` / CLOUDFLARE_API_TOKEN)
```

CI does not deploy the Worker: a change under `src/` reaches Cloudflare only through `pnpm run deploy` (a bare `pnpm deploy` is pnpm's own workspace-deploy command and never runs this script).

Then, in the Cloudflare dashboard (or API): enable **Email Routing** on `civfix.org` (auto-manages
MX/TXT and **takes over inbound mail for the domain** — confirm no other inbound provider first), and
set the **catch-all** route Action to **Send to a Worker** → `civfix-inbound-email`. The
`/webhooks/*` path stays un-gated by Cloudflare Access, so the Worker can POST it through the tunnel.

A nudge the backend rejects (non-2xx) or that fails to send is logged with `console.error` and the
object's key; the backend's `inbound.sweep` picks the object up either way.
