/**
 * Pure helpers for the migration runner: discovering and ordering the hand-authored .sql files.
 *
 * Kept separate from migrate.ts (which has the side-effecting DB application) so the ordering logic
 * can be unit-tested with an injected directory listing and no filesystem or database.
 */

/**
 * Given a directory listing, return only the migration .sql files in the order they must be applied:
 * lexical (ASCII) ascending by filename. The numeric prefixes (0000_, 0001_, ...) make lexical order
 * equal to intended order; we sort explicitly so callers never depend on readdir() ordering, which is
 * platform/filesystem dependent.
 *
 * Non-.sql entries are ignored. Comparison is a plain code-unit compare (localeCompare with the "en"
 * locale and numeric:false) so it is deterministic across machines.
 *
 * @param entries raw directory entries (file names, not paths).
 * @returns the .sql file names, sorted ascending.
 */
export function orderMigrationFiles(entries: readonly string[]): string[] {
  return entries
    .filter((name) => name.toLowerCase().endsWith(".sql"))
    .slice()
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
}
