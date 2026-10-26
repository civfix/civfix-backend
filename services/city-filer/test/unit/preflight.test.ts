import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  envOutputFailure,
  FILER_ENV_KEYS,
  filerStatusFailure,
  runPreflight,
} from "../../src/preflight.js"
import { makeWorkspace } from "../helpers/filer-harness.js"

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "filer-preflight-"))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

function status(id: number, caps: { CapEff?: string; all?: string } = {}): string {
  const cap = (name: string) =>
    `${name}:\t${(name === "CapEff" ? caps.CapEff : undefined) ?? caps.all ?? "0000000000000000"}`
  const ids = `${id}\t${id}\t${id}\t${id}`
  return [
    `Uid:\t${ids}`,
    `Gid:\t${ids}`,
    ...["CapInh", "CapPrm", "CapEff", "CapAmb"].map(cap),
    "",
  ].join("\n")
}

const FILER_ENV =
  "HOME=/home/filer\nPATH=/usr/local/bin:/usr/bin:/bin\nPLAYWRIGHT_BROWSERS_PATH=/ms-playwright\nTMPDIR=/tmp\n"

/** A filer-shell that answers `env`, `id -u` and `cat /proc/self/status` with canned output. */
async function cannedFilerShell(env: string, childStatus: string): Promise<string> {
  await writeFile(join(dir, "env.txt"), env)
  await writeFile(join(dir, "status.txt"), childStatus)
  const script = `#!/bin/sh
extra=
[ "$1" = --run-dir ] && { extra="FILER_RUN_DIR=$2\nFILER_HOST=$4\n"; shift 4; }
[ "$1" = -- ] && shift
case "$1" in
  env) cat ${dir}/env.txt; printf "$extra" ;;
  id) echo 1001 ;;
  cat) cat ${dir}/status.txt ;;
  *) exit 1 ;;
esac
`
  await writeFile(join(dir, "filer-shell"), script, { mode: 0o755 })
  return join(dir, "filer-shell")
}

describe("the preflight", () => {
  it("T24: a child with a non-zero CapEff, or filer-shell env printing DATABASE_URL or PWD, fails it", async () => {
    const badCaps = status(1001, { CapEff: "0000000000000040" })
    const cases = [
      [FILER_ENV, badCaps],
      [`${FILER_ENV}DATABASE_URL=postgres://x\n`, status(1001)],
      [`${FILER_ENV}PWD=/app\n`, status(1001)],
    ] as const
    expect(filerStatusFailure(badCaps)).not.toBeNull()
    for (const [env] of cases.slice(1)) expect(envOutputFailure(env, FILER_ENV_KEYS)).not.toBeNull()

    const workspaceDir = await makeWorkspace(dir)
    const exitCodes = []
    const failures: string[] = []
    for (const [env, childStatus] of cases) {
      const filerShell = await cannedFilerShell(env, childStatus)
      exitCodes.push(
        await runPreflight({
          runner: { filerShell, nodeBinary: process.execPath, kitRunScript: "/nonexistent" },
          workspaceDir,
          ownStatus: () => Promise.resolve(status(1000, { all: "00000000000000c0" })),
          nodeUid: 1000,
          env: { ...process.env, DATABASE_URL: "postgres://x" },
          log: (line) => void failures.push(line),
        }),
      )
    }
    expect(exitCodes).toEqual([1, 1, 1])
    // Each fails on its own check, not on an earlier one.
    expect(failures).toHaveLength(3)
    expect(failures[0]).toMatch(/CapEff/)
    expect(failures[1]).toMatch(/DATABASE_URL/)
    expect(failures[2]).toMatch(/PWD/)
  })
})
