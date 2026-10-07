/**
 * Sorts explicitly because readdir() order is filesystem-dependent, and with a code-unit compare rather
 * than localeCompare so the order is identical on every machine and locale.
 */
export function orderMigrationFiles(entries: readonly string[]): string[] {
  return entries
    .filter((name) => name.toLowerCase().endsWith(".sql"))
    .slice()
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
}
