/**
 * Seed runner placeholder. Real seed data (sample jurisdictions, demo reports) lands in a later
 * step. For now this is a no-op that exits 0 so `pnpm db:seed` is always wired and safe to call.
 */

async function main(): Promise<void> {
  console.log("seed: nothing to seed yet (scaffold). This will be implemented in a later step.")
}

main().catch((err: unknown) => {
  console.error("seed: failed")
  console.error(err)
  process.exit(1)
})
