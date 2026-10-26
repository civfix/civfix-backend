import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"

/**
 * A script that passes the proof without a browser: its dry run ends at a linked_existing result(), which
 * prints the kit's sentinel, and its live run records `submitted`.
 */
export const PROVABLE_SCRIPT = `import { result } from "@civfix/filer-kit"
export default async () =>
  process.argv.includes("--dry-run")
    ? result({ outcome: "linked_existing", caseId: "SR-0007" })
    : result({ outcome: "submitted", caseId: "SR-0007" })
`

/** A script that throws before it reaches the submit, live or dry. */
export const FAILING_SCRIPT = `export default async () => {
  throw new Error("the form moved")
}
`

export const fixtureScript = async (): Promise<string> =>
  readFile(fileURLToPath(new URL("../fixtures/portal-script.mjs", import.meta.url)), "utf8")

/** Act lines: write `source` as this run's host's script.mjs. */
export const writes = (source: string): string => `writeScript(${JSON.stringify(source)}, host)`

/** Act lines: write `body` as out/result.json. */
export const resultFile = (body: Record<string, unknown>): string =>
  `fs.writeFileSync(join(runDir, "out", "result.json"), ${JSON.stringify(JSON.stringify(body))})`

/** A failed `--output-format json` result with `text`. */
export const errorResult = (text: string): string =>
  `return { type: "result", subtype: "success", is_error: true, result: ${JSON.stringify(text)} }`
