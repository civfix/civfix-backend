const FORMULA_ESCAPE = "'"
const LEADING_TRIGGER_RE = /^[=+\-@\t\r]/
// Excel in a ';'-separator locale (de, es) splits a quoted value on ';' and evaluates a formula at the
// start of the resulting field, so quoting alone does not help. Spaces and double quotes between the
// separator and the trigger do not stop that evaluation, so the escape goes directly before the
// trigger. A single quote is left out because a field that starts with one is already text. The
// lookbehind (rather than a consuming match) also catches a trigger that follows a tab or CR which
// was itself a trigger. The lookahead goes first so the unbounded lookbehind only runs where a trigger
// follows; no trigger is in `[ "]`, so each run of spaces is scanned once instead of once per position.
const SEPARATED_TRIGGER_RE = /(?=[=+\-@\t\r])(?<=[;,\t\r\n][ "]*)/g

function neutralizeFormulas(value: string): string {
  const separated = value.replace(SEPARATED_TRIGGER_RE, FORMULA_ESCAPE)
  return LEADING_TRIGGER_RE.test(separated) ? `${FORMULA_ESCAPE}${separated}` : separated
}

export function csvCell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return ""
  // A number cannot carry a formula, and prefixing a negative one would turn it into text.
  const text = typeof value === "number" ? String(value) : neutralizeFormulas(value)
  return `"${text.replace(/"/g, '""')}"`
}

export function csvRow(cells: readonly (string | number | null | undefined)[]): string {
  return `${cells.map(csvCell).join(",")}\n`
}

export function csvProvenanceRow(text: string): string {
  return csvRow([`# ${text}`])
}
