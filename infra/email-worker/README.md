# civfix Email Worker

Cloudflare Email Worker that ingests catch-all `*@civfix.org` mail. It writes the raw `.eml` to
**R2** (`inbound/pending/<slug>.<digest>.eml`, the source of truth) and best-effort POSTs an HMAC-signed
`{ key }` nudge to the backend webhook. The backend re-fetches from R2, parses, routes (reply → mail
thread; else → inbox), and reconciles `inbound/pending/` on boot + a cron sweep, so a missed nudge is
never a lost message.

The pending key is `<slug>.<digest>`: `<slug>` is the Message-ID with `<>` stripped and every character
outside `A-Za-z0-9._@-` replaced by `_`, cut to 120 characters, and `<digest>` is the first 32 hex
characters of the SHA-256 of the raw message. The sender chooses the Message-ID, so the digest keeps a
second mail with the same (or a same-slugging) Message-ID from overwriting a pending one, while a
byte-identical redelivery lands on the same key. A message with no Message-ID is stored under the full
64-character digest alone.

The Worker does **not** judge sender authentication. `message.headers` does not expose the
`Authentication-Results` header Cloudflare stamps (workerd#6740), so a header check here never fired.
The backend is the only gate: it reads the top-most `Authentication-Results` in the raw message and
trusts it only when its authserv-id is `mx.cloudflare.net`.

See `documents/17-inbound-email-worker.md` for the full pipeline + enablement guide.

## Layout

Standalone — **not** in the backend pnpm/Turbo workspace (own `wrangler` toolchain).

```
src/index.ts   the email() handler
wrangler.toml  bindings (R2_BUCKET), vars (BACKEND_WEBHOOK_URL), prod/staging envs
test/          vitest unit tests (id derivation, HMAC fixture shared with the backend)
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
Authentication-Results: mx.cloudflare.net; spf=pass; dkim=pass header.d=example.gov; dmarc=pass header.from=example.gov
Content-Type: text/plain

We received your report.'
```

Expect an `inbound/pending/test-001@example.gov.<digest>.eml` object and a signed POST to your local
backend.

## Deploy + enable Email Routing

```sh
pnpm deploy            # wrangler deploy --env production (after `wrangler login` / CLOUDFLARE_API_TOKEN)
```

Then, in the Cloudflare dashboard (or API): enable **Email Routing** on `civfix.org` (auto-manages
MX/TXT and **takes over inbound mail for the domain** — confirm no other inbound provider first), and
set the **catch-all** route Action to **Send to a Worker** → `civfix-inbound-email`. The
`/webhooks/*` path stays un-gated by Cloudflare Access (documents/16), so the Worker can POST it
through the tunnel. Details + the catch-all API call: `documents/17-inbound-email-worker.md`.
