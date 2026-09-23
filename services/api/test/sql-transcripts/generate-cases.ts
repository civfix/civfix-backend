// Writes cases.generated.ts: one transcript case per exported function that takes a postgres.js handle as
// its first parameter, and one per method of every object such a factory returns. Arguments are
// synthesized from the declared parameter types, so the cases need no hand upkeep and a regenerated file
// only changes when a signature does.
//
//   pnpm --filter @civfix/api exec tsx test/sql-transcripts/generate-cases.ts

import { writeFileSync } from "node:fs"
import { dirname, join, relative } from "node:path"
import { fileURLToPath } from "node:url"
import * as prettier from "prettier"
import ts from "typescript"

const HERE = dirname(fileURLToPath(import.meta.url))
const API_ROOT = join(HERE, "..", "..")
const SRC = join(API_ROOT, "src")
const OUT = join(HERE, "cases.generated.ts")

const SQL_TYPE_NAMES = new Set(["Sql", "Queryable", "TransactionSql"])
const MAX_DEPTH = 4
const FIXED_DATE = 'new Date("2026-03-04T05:06:07.000Z")'

// Scripts that connect on import or only run as CLIs; they are not request paths and are not moved.
const EXCLUDED_DIRS = [join(SRC, "db")]

interface Case {
  key: string
  module: string
  exportName: string
  factoryArgs: string[] | null
  sqlFirst: boolean
  method: string | null
  args: string[]
}

const configPath = ts.findConfigFile(API_ROOT, ts.sys.fileExists, "tsconfig.json")
if (!configPath) throw new Error("tsconfig.json not found")
const config = ts.getParsedCommandLineOfConfigFile(
  configPath,
  {},
  { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => undefined },
)
if (!config) throw new Error("could not parse tsconfig.json")
const program = ts.createProgram(config.fileNames, config.options)
const checker = program.getTypeChecker()

function isSqlType(type: ts.Type): boolean {
  const symbol = type.aliasSymbol ?? type.getSymbol()
  if (symbol && SQL_TYPE_NAMES.has(symbol.getName())) return true
  const text = checker.typeToString(type)
  return /^(Sql|Queryable|TransactionSql)\b|postgres\.(Sql|TransactionSql)\b|^Sql<|TransactionSql</.test(
    text,
  )
}

function carriesSql(type: ts.Type): boolean {
  if (isSqlType(type)) return true
  if (type.isUnion()) return type.types.some((t) => isSqlType(t))
  if (!(type.flags & ts.TypeFlags.Object) || type.getCallSignatures().length > 0) return false
  return checker.getPropertiesOfType(type).some((p) => {
    const decl = p.valueDeclaration ?? p.declarations?.[0]
    return (
      decl !== undefined &&
      isSqlType(checker.getNonNullableType(checker.getTypeOfSymbolAtLocation(p, decl)))
    )
  })
}

function literal(value: string): string {
  return JSON.stringify(value)
}

function synth(type: ts.Type, name: string, depth: number, seen: Set<ts.Type>): string {
  if (isSqlType(type)) return "sql"
  if (depth > MAX_DEPTH) return "undefined"

  if (type.isUnion()) {
    const members = type.types.filter(
      (t) => !(t.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Null | ts.TypeFlags.Void)),
    )
    if (members.length === 0) return "null"
    const allBooleanLiterals = members.every((t) => t.flags & ts.TypeFlags.BooleanLiteral)
    if (allBooleanLiterals) return "true"
    return synth(members[0]!, name, depth, seen)
  }
  if (type.isStringLiteral()) return literal(type.value)
  if (type.isNumberLiteral()) return String(type.value)
  if (type.flags & ts.TypeFlags.BooleanLiteral) return checker.typeToString(type)
  if (type.flags & ts.TypeFlags.String) return literal(`${name}-1`)
  if (type.flags & ts.TypeFlags.TemplateLiteral) return literal(`${name}-1`)
  if (type.flags & ts.TypeFlags.Number) return "3"
  if (type.flags & ts.TypeFlags.Boolean) return "true"
  if (type.flags & ts.TypeFlags.BigInt) return "5n"
  if (type.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined | ts.TypeFlags.Void))
    return "undefined"
  if (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return literal(`${name}-any`)
  if (type.flags & ts.TypeFlags.EnumLiteral && type.isLiteral()) return JSON.stringify(type.value)

  if (type.getProperty("then") !== undefined && type.getProperty("describe") !== undefined) {
    return `sql\`TRUE /* ${name} */\``
  }
  const symbolName = type.getSymbol()?.getName()
  if (symbolName === "Date") return FIXED_DATE
  if (symbolName === "Uint8Array" || symbolName === "Buffer") return "new Uint8Array([1, 2, 3])"
  if (symbolName === "AbortSignal") return "new AbortController().signal"
  if (symbolName === "Promise") {
    const [inner] = checker.getTypeArguments(type as ts.TypeReference)
    return `Promise.resolve(${inner ? synth(inner, name, depth + 1, seen) : "undefined"})`
  }
  if (symbolName === "Set" || symbolName === "ReadonlySet") {
    const [inner] = checker.getTypeArguments(type as ts.TypeReference)
    return `new Set([${inner ? synth(inner, name, depth + 1, seen) : ""}])`
  }
  if (symbolName === "Map" || symbolName === "ReadonlyMap") {
    const [k, v] = checker.getTypeArguments(type as ts.TypeReference)
    return `new Map([[${k ? synth(k, `${name}Key`, depth + 1, seen) : '"k"'}, ${v ? synth(v, name, depth + 1, seen) : "undefined"}]])`
  }
  if (checker.isTupleType(type)) {
    const elems = checker.getTypeArguments(type as ts.TypeReference)
    return `[${elems.map((e, i) => synth(e, `${name}${i}`, depth + 1, seen)).join(", ")}]`
  }
  if (checker.isArrayType(type)) {
    const [inner] = checker.getTypeArguments(type as ts.TypeReference)
    return `[${inner ? synth(inner, singular(name), depth + 1, seen) : ""}]`
  }

  const signatures = type.getCallSignatures()
  if (signatures.length > 0) {
    const ret = signatures[0]!.getReturnType()
    return `() => ${wrapObject(synth(ret, `${name}Result`, depth + 1, seen))}`
  }

  if (type.flags & ts.TypeFlags.Object) {
    if (seen.has(type)) return "{}"
    const next = new Set(seen).add(type)
    const props = checker.getPropertiesOfType(type).filter((p) => !p.getName().startsWith("__@"))
    const index = type.getStringIndexType()
    const fields = props.map((p) => {
      const decl = p.valueDeclaration ?? p.declarations?.[0]
      const propType = decl
        ? checker.getTypeOfSymbolAtLocation(p, decl)
        : checker.getDeclaredTypeOfSymbol(p)
      return `${JSON.stringify(p.getName())}: ${synth(propType, p.getName(), depth + 1, next)}`
    })
    if (props.length === 0 && index)
      fields.push(`${JSON.stringify(`${name}Key`)}: ${synth(index, name, depth + 1, next)}`)
    return `{ ${fields.join(", ")} }`
  }
  return literal(`${name}-unsupported`)
}

function wrapObject(expr: string): string {
  return expr.startsWith("{") ? `(${expr})` : expr
}

function singular(name: string): string {
  return name.endsWith("s") ? name.slice(0, -1) : `${name}Item`
}

function paramArgs(signature: ts.Signature, skipFirst: boolean): string[] {
  const params = signature.getParameters().slice(skipFirst ? 1 : 0)
  return params.map((p) => {
    const decl = p.valueDeclaration as ts.ParameterDeclaration | undefined
    const type = decl
      ? checker.getTypeOfSymbolAtLocation(p, decl)
      : checker.getDeclaredTypeOfSymbol(p)
    if (decl?.dotDotDotToken) {
      const inner = checker.isArrayType(type)
        ? checker.getTypeArguments(type as ts.TypeReference)[0]
        : undefined
      return inner ? `...[${synth(inner, p.getName(), 0, new Set())}]` : "...[]"
    }
    return synth(type, p.getName(), 0, new Set())
  })
}

function methodsOf(type: ts.Type): { name: string; signature: ts.Signature }[] {
  const out: { name: string; signature: ts.Signature }[] = []
  for (const prop of checker.getPropertiesOfType(type)) {
    const decl = prop.valueDeclaration ?? prop.declarations?.[0]
    if (!decl) continue
    const propType = checker.getNonNullableType(checker.getTypeOfSymbolAtLocation(prop, decl))
    const sig = propType.getCallSignatures()[0]
    if (sig) out.push({ name: prop.getName(), signature: sig })
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

const cases: Case[] = []
const sources = program
  .getSourceFiles()
  .filter(
    (sf) => sf.fileName.startsWith(SRC) && !EXCLUDED_DIRS.some((d) => sf.fileName.startsWith(d)),
  )
  .sort((a, b) => a.fileName.localeCompare(b.fileName))

for (const sf of sources) {
  const moduleSymbol = checker.getSymbolAtLocation(sf)
  if (!moduleSymbol) continue
  const module = `../../${relative(API_ROOT, sf.fileName).replace(/\.ts$/, ".js")}`
  for (const exp of checker.getExportsOfModule(moduleSymbol)) {
    const decl = exp.valueDeclaration
    if (!decl) continue
    const type = checker.getTypeOfSymbolAtLocation(exp, decl)
    const sig = type.getCallSignatures()[0]
    if (!sig || type.getConstructSignatures().length > 0) continue
    const params = sig.getParameters()
    const sqlFirst = params[0]?.valueDeclaration
      ? isSqlType(checker.getTypeOfSymbolAtLocation(params[0], params[0].valueDeclaration))
      : false
    const takesSql = params.some(
      (p) =>
        p.valueDeclaration !== undefined &&
        carriesSql(checker.getTypeOfSymbolAtLocation(p, p.valueDeclaration)),
    )
    if (!takesSql) continue

    const factoryArgs = paramArgs(sig, sqlFirst)
    const returnType = sig.getReturnType()
    const thenable = returnType.getProperty("then") !== undefined
    const methods = thenable ? [] : methodsOf(returnType)
    const exportName = exp.getName()
    if (methods.length > 0) {
      for (const m of methods) {
        cases.push({
          key: `${exportName}.${m.name}`,
          module,
          exportName,
          factoryArgs,
          sqlFirst,
          method: m.name,
          args: paramArgs(m.signature, false),
        })
      }
    } else {
      cases.push({
        key: exportName,
        module,
        exportName,
        factoryArgs: null,
        sqlFirst,
        method: null,
        args: factoryArgs,
      })
    }
  }
}

const keyCounts = new Map<string, number>()
for (const c of cases) keyCounts.set(c.key, (keyCounts.get(c.key) ?? 0) + 1)
for (const c of cases) {
  if ((keyCounts.get(c.key) ?? 0) > 1)
    c.key = `${c.key}@${c.module.split("/").pop()?.replace(/\.js$/, "")}`
}

const modules = [...new Set(cases.map((c) => c.module))]
const importName = (m: string): string => `m${modules.indexOf(m)}`

const body = `// Generated by test/sql-transcripts/generate-cases.ts. Do not edit by hand; regenerate instead.
import type { Sql } from "../../src/db/client.js"
${modules.map((m) => `import * as ${importName(m)} from ${JSON.stringify(m)}`).join("\n")}

export interface TranscriptCase {
  key: string
  run(sql: Sql): Promise<unknown>
}

export const cases: TranscriptCase[] = [
${cases
  .map((c) => {
    const target = `(${importName(c.module)} as any).${c.exportName}`
    const argList = (args: string[]): string => (c.sqlFirst ? ["sql", ...args] : args).join(", ")
    const call =
      c.method === null
        ? `${target}(${argList(c.args)})`
        : `${target}(${argList(c.factoryArgs ?? [])}).${c.method}(${c.args.join(", ")})`
    return `  { key: ${JSON.stringify(c.key)}, run: async (sql: any) => ${call} },`
  })
  .join("\n")}
]
`

// Prettier is not idempotent on long member chains, so format until the output is stable; a single pass
// would disagree with `prettier --check`.
const prettierOptions = { ...(await prettier.resolveConfig(OUT)), filepath: OUT }
let formatted = await prettier.format(body, prettierOptions)
for (let pass = 0; pass < 5; pass++) {
  const again = await prettier.format(formatted, prettierOptions)
  if (again === formatted) break
  formatted = again
}
writeFileSync(OUT, formatted)
console.log(
  `wrote ${cases.length} cases from ${modules.length} modules to ${relative(process.cwd(), OUT)}`,
)
