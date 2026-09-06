const INJECTION_PREFIX_RE = /^[=+\-@\t\r]/

export function csvCell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return ""
  const raw = typeof value === "number" ? String(value) : value
  const guarded = INJECTION_PREFIX_RE.test(raw) ? `'${raw}` : raw
  if (/[",\n\r]/.test(guarded)) return `"${guarded.replace(/"/g, '""')}"`
  return guarded
}

export function csvRow(cells: readonly (string | number | null | undefined)[]): string {
  return `${cells.map(csvCell).join(",")}\n`
}

export function csvProvenanceRow(text: string): string {
  return csvRow([`# ${text}`])
}
