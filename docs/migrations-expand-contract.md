# Expand/contract: why every migration in a release must be additive

**Rule: a release may only EXPAND the schema. Contraction ships one release later.**

## Why

The production deploy is blue/green (`civfix-infra` compose + `ops/deploy.sh`):

1. the `migrate` one-shot applies every new `services/api/drizzle/*.sql` file;
2. the NEW api color starts and is proved healthy;
3. Caddy is flipped to it;
4. the PREVIOUS color gets SIGTERM and keeps serving its in-flight work for the drain window
   (`SHUTDOWN_DRAIN_MS`, 8s) plus the bounded close that follows it.

Between (1) and (4) the **previous release's code is serving live traffic against the new schema** —
for minutes in a normal deploy, and indefinitely if the deploy is rolled back with `CIVFIX_REF=<sha>`
(the rollback moves the code back; migrations are forward-only and are NOT reverted).

A migration that removes or tightens something therefore breaks the still-running old image:

| Destructive DDL | What the old image does |
| --- | --- |
| `DROP COLUMN` / `DROP TABLE` | every `SELECT`/`INSERT` naming it fails: `column ... does not exist` |
| rename column/table | same, and the new code is fine, so the failure looks like a random 500 wave |
| `SET NOT NULL` on an existing column | old `INSERT`s that omit the column fail; the `ACCESS EXCLUSIVE` scan also blocks writes |
| narrowed type / dropped enum value | old writes fail on values the new schema no longer accepts |
| `ADD CONSTRAINT ... CHECK` (validating) | old writes that violate it fail, and the validation scan locks the table |

## What that means in practice

- **Additive only, in the same release**: new tables, new nullable/DEFAULTed columns, new indexes
  (`CONCURRENTLY` and out-of-band on a hot table — reports, chat_messages, media_assets, users), new
  constraints added `NOT VALID` and validated later.
- **A rename is two releases**: (1) add the new column, dual-write, backfill; (2) after the release
  that stopped reading the old column is fully deployed, drop it.
- **A drop is one release after the code stopped depending on it.** "The code no longer uses it" is
  not enough — the release that removes the usage has to be the one running everywhere first.
- **`NOT NULL` is two releases**: backfill + `CHECK (col IS NOT NULL) NOT VALID`, then `VALIDATE` and
  `SET NOT NULL` in a later release.
- **Backfills** live in their own migration, are idempotent and re-runnable, and the reading code
  keeps a fail-closed fallback until the contract-side release (e.g. the deliberate `?? new Date(0)`
  in `src/auth/pg-stores.ts`).

## Checklist for a schema PR

- [ ] Would the PREVIOUS image, running unchanged, still serve every request after this migration?
- [ ] Is the migration idempotent (`IF NOT EXISTS` / no-op on re-apply)?
- [ ] Is the Drizzle mirror in `src/db/schema/` updated to match exactly?
- [ ] If anything destructive is needed, is it filed as a follow-up release rather than added here?

See also: README "Migrations" and "Deploy (Docker Compose, via the civfix-infra repo)", and
`.claude/skills/civfix-migration` in the umbrella for the full DDL recipe.
