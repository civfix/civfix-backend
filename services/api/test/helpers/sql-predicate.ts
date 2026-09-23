export type PredicateRow = Record<string, string | null>

export function evalSqlPredicate(text: string, row: PredicateRow): boolean {
  const js = text
    .replace(/\b[a-z_]+\.([a-z_]+)\b/g, (_all, column: string) => `row[${JSON.stringify(column)}]`)
    .replace(/\s+IS NOT NULL\b/g, " !== null")
    .replace(/\s+IS NULL\b/g, " === null")
    .replace(/<>/g, "!==")
    .replace(/(?<![!<>=])=(?!=)/g, "===")
    .replace(/\bOR\b/g, "||")
    .replace(/\bAND\b/g, "&&")
  const compiled = new Function("row", `"use strict"; return Boolean(${js})`) as (
    candidate: PredicateRow,
  ) => boolean
  return compiled(row)
}
