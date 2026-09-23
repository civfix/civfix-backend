const INJECTION_PREFIX_RE = /^[=+\-@\t\r]/

export function csvCell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return ""
  const raw = typeof value === "number" ? String(value) : value
  const guarded = INJECTION_PREFIX_RE.test(raw) ? `'${raw}` : raw
  // Quoting every cell, not only those holding a comma, keeps a ';' inside the value from opening a
  // new field (and a formula) when a list-separator ';' locale of Excel opens the file.
  return `"${guarded.replace(/"/g, '""')}"`
}

export function csvRow(cells: readonly (string | number | null | undefined)[]): string {
  return `${cells.map(csvCell).join(",")}\n`
}

export function csvProvenanceRow(text: string): string {
  return csvRow([`# ${text}`])
}
