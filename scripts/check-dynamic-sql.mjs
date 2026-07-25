#!/usr/bin/env node
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"

const ROOTS = ["services/api/src", "services/media-worker/src"]
const ALLOW_UNSAFE = new Set([
  "services/api/src/db/migrate.ts",
  "services/api/src/db/backfill-jurisdictions-core.ts",
  // Same reviewed shape as the jurisdictions backfill above: `ORDER BY ${sql.unsafe(...)}` over the
  // JURISDICTION_LAYER_RANK_CASE module constant in db/sql/jurisdiction.ts. No request data reaches it,
  // and it is an offline CLI, not a served route.
  "services/api/src/db/backfill-reference-codes-core.ts",
  "services/api/src/db/sql/jurisdiction.ts",
  "services/api/src/services/media-worker-repo.ts",
])

const walk = (dir) =>
  readdirSync(dir).flatMap((name) => {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) return walk(full)
    return name.endsWith(".ts") && !name.endsWith(".test.ts") ? [full] : []
  })

const REGEX_PRECEDING_KEYWORDS = new Set([
  "return", "typeof", "instanceof", "in", "of", "new", "delete", "void",
  "do", "else", "yield", "await", "case", "throw",
])

function isIdentStart(c) {
  return (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || c === "_" || c === "$" || c.charCodeAt(0) > 127
}
function isIdentPart(c) {
  return isIdentStart(c) || (c >= "0" && c <= "9")
}

function stripComments(input) {
  const n = input.length
  let scanFrom = 0
  if (input.startsWith("#!")) {
    const nl = input.indexOf("\n")
    scanFrom = nl === -1 ? n : nl + 1
  }

  const spans = []
  let prevType = "none"
  let prevWord = ""

  function scanString(i, q) {
    i++
    while (i < n) {
      const c = input[i]
      if (c === "\\") { i += 2; continue }
      if (c === q) return i + 1
      if (c === "\n") return i
      i++
    }
    return i
  }

  function scanRegex(i) {
    i++
    let inClass = false
    while (i < n) {
      const c = input[i]
      if (c === "\n") return i
      if (c === "\\") { i += 2; continue }
      if (c === "[") { inClass = true; i++; continue }
      if (c === "]") { inClass = false; i++; continue }
      if (c === "/" && !inClass) { i++; break }
      i++
    }
    while (i < n && isIdentPart(input[i])) i++
    return i
  }

  function scanTemplate(i) {
    i++
    while (i < n) {
      const c = input[i]
      if (c === "\\") { i += 2; continue }
      if (c === "`") return i + 1
      if (c === "$" && input[i + 1] === "{") {
        i = scanCode(i + 2, true)
        if (input[i] === "}") i++
        continue
      }
      i++
    }
    return i
  }

  function regexAllowed() {
    if (prevType === "none") return true
    if (prevType === "punct") return true
    if (prevType === "value") return false
    if (prevType === "word") return REGEX_PRECEDING_KEYWORDS.has(prevWord)
    return false
  }

  function scanCode(i, stopAtBrace) {
    let depth = 0
    while (i < n) {
      const c = input[i]
      if (c === " " || c === "\t" || c === "\n" || c === "\r") { i++; continue }
      if (c === "/" && input[i + 1] === "/") {
        const start = i
        i += 2
        while (i < n && input[i] !== "\n") i++
        spans.push({ start, end: i })
        continue
      }
      if (c === "/" && input[i + 1] === "*") {
        const start = i
        i += 2
        while (i < n && !(input[i] === "*" && input[i + 1] === "/")) i++
        i = i < n ? i + 2 : n
        spans.push({ start, end: i })
        continue
      }
      if (c === '"' || c === "'") { i = scanString(i, c); prevType = "value"; prevWord = ""; continue }
      if (c === "`") { i = scanTemplate(i); prevType = "value"; prevWord = ""; continue }
      if (c === "/") {
        if (regexAllowed()) { i = scanRegex(i); prevType = "value"; prevWord = "" }
        else { i++; prevType = "punct"; prevWord = "" }
        continue
      }
      if (isIdentStart(c)) {
        const s = i
        i++
        while (i < n && isIdentPart(input[i])) i++
        prevWord = input.slice(s, i)
        prevType = "word"
        continue
      }
      if (c >= "0" && c <= "9") {
        i++
        while (i < n && /[0-9a-fA-FxXbBoOeE._n]/.test(input[i])) i++
        prevType = "value"; prevWord = ""
        continue
      }
      if (c === "{") { depth++; i++; prevType = "punct"; prevWord = ""; continue }
      if (c === "}") {
        if (stopAtBrace && depth === 0) return i
        if (depth > 0) depth--
        i++; prevType = "punct"; prevWord = ""
        continue
      }
      i++
      if (c === ")" || c === "]") { prevType = "value"; prevWord = "" }
      else { prevType = "punct"; prevWord = "" }
    }
    return i
  }

  scanCode(scanFrom, false)

  let out = ""
  let pos = 0
  for (const span of spans) {
    out += input.slice(pos, span.start) + " "
    pos = span.end
  }
  out += input.slice(pos)
  return out
}

const violations = []
for (const root of ROOTS) {
  for (const file of walk(root)) {
    const code = stripComments(readFileSync(file, "utf8"))
    if (/\bsql\.identifier\s*\(/.test(code)) violations.push(`${file}: sql.identifier() is forbidden`)
    if (/\bsql\.raw\s*\(/.test(code)) violations.push(`${file}: sql.raw() is forbidden`)
    if (/\bsql\.unsafe\s*\(/.test(code) && !ALLOW_UNSAFE.has(file))
      violations.push(`${file}: sql.unsafe() outside the reviewed allowlist`)
  }
}

if (violations.length > 0) {
  console.error("Dynamic-SQL guard failed:\n" + violations.map((v) => "  - " + v).join("\n"))
  process.exit(1)
}
console.log("Dynamic-SQL guard: clean")
