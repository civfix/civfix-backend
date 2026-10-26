import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
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
          mcpDir: "/nonexistent",
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

const KIT_CORE = (
  JSON.parse(
    await readFile(fileURLToPath(new URL("../../package.json", import.meta.url)), "utf8"),
  ) as { dependencies: Record<string, string> }
).dependencies["playwright-core"]

const HELP = `Usage: claude [options] [command] [prompt]
  -p, --print                       Print response and exit
  --output-format <format>          Output format
  --tools <tools...>                Built-in tools
  --strict-mcp-config               Only use MCP servers from --mcp-config
  --mcp-config <configs...>         Load MCP servers
  --append-system-prompt-file <f>   Append a system prompt from a file
  --dangerously-skip-permissions    Bypass all permission checks
`

const FILER_PROCESS = { pid: 7, keys: ["HOME", "PATH", "PLAYWRIGHT_BROWSERS_PATH", "TMPDIR"] }

interface Canned {
  claudeVersionExit?: number
  cswapVersionExit?: number
  mcpHelpExit?: number
  help?: string
  environ?: unknown
  mcpCore?: string
}

/** A filer-shell whose every check passes unless `c` says otherwise; it answers by the command it gets. */
async function claudePreflight(c: Canned = {}): Promise<{ exit: number; lines: string[] }> {
  await writeFile(join(dir, "env.txt"), FILER_ENV)
  await writeFile(join(dir, "status.txt"), status(1001))
  await writeFile(join(dir, "help.txt"), c.help ?? HELP)
  await writeFile(join(dir, "environ.json"), JSON.stringify(c.environ ?? [FILER_PROCESS]))
  const shell = `#!/bin/sh
extra=
[ "$1" = --run-dir ] && { extra="FILER_RUN_DIR=$2\\nFILER_HOST=$4\\n"; shift 4; }
[ "$1" = -- ] && shift
case "$*" in
  env) cat ${dir}/env.txt; printf "$extra" ;;
  "id -u") echo 1001 ;;
  "cat /proc/self/status") cat ${dir}/status.txt ;;
  *chromium.launch*) echo ok ;;
  *createAtTop*) echo '{"createAtTop":"EACCES","renameRun":"EACCES","writePacket":"EACCES","replaceOut":"EACCES","writeIntoOut":"ok"}' ;;
  */environ*) cat ${dir}/environ.json ;;
  "claude --version") echo "2.1.310 (Claude Code)"; exit ${c.claudeVersionExit ?? 0} ;;
  "cswap --version") echo "claude-swap 0.28.0"; exit ${c.cswapVersionExit ?? 0} ;;
  "claude --help") cat ${dir}/help.txt ;;
  "playwright-mcp --help") echo "Usage: playwright-mcp [options]"; exit ${c.mcpHelpExit ?? 0} ;;
  *) exit 1 ;;
esac
`
  await writeFile(join(dir, "filer-shell"), shell, { mode: 0o755 })
  const mcpDir = join(dir, "mcp")
  await mkdir(join(mcpDir, "node_modules", "playwright-core"), { recursive: true })
  await writeFile(join(mcpDir, "package.json"), '{"name":"@playwright/mcp"}')
  await writeFile(
    join(mcpDir, "node_modules", "playwright-core", "package.json"),
    JSON.stringify({ name: "playwright-core", version: c.mcpCore ?? KIT_CORE }),
  )
  const workspaceDir = await makeWorkspace(await mkdtemp(join(dir, "ws-")))
  const lines: string[] = []
  const exit = await runPreflight({
    runner: {
      filerShell: join(dir, "filer-shell"),
      nodeBinary: process.execPath,
      kitRunScript: "/nonexistent",
    },
    workspaceDir,
    ownStatus: () => Promise.resolve(status(1000, { all: "00000000000000c0" })),
    nodeUid: 1000,
    env: {},
    mcpDir,
    log: (line) => void lines.push(line),
  })
  return { exit, lines }
}

describe("the preflight's Claude Code checks", () => {
  it("T20: claude --version failing as filer, cswap --version failing, DATABASE_URL in a filer process's environ, and a different mcp playwright-core each exit non-zero", async () => {
    const cases: [Canned, RegExp][] = [
      [{ claudeVersionExit: 1 }, /claude --version/],
      [{ cswapVersionExit: 1 }, /cswap --version/],
      [{ environ: [FILER_PROCESS, { pid: 9, keys: ["HOME", "DATABASE_URL"] }] }, /DATABASE_URL/],
      [{ mcpCore: "1.63.0" }, /playwright-core 1\.63\.0/],
    ]
    for (const [canned, failure] of cases) {
      const { exit, lines } = await claudePreflight(canned)
      expect(exit).toBe(1)
      expect(lines).toEqual([expect.stringMatching(failure)])
    }
  })

  it("T25: claude --help without --strict-mcp-config, and playwright-mcp --help exiting non-zero as filer, exit non-zero; with every check passing it exits 0", async () => {
    const noStrict = await claudePreflight({
      help: HELP.replace(/^.*--strict-mcp-config .*\n/m, ""),
    })
    const noMcp = await claudePreflight({ mcpHelpExit: 2 })
    const passing = await claudePreflight()

    expect(noStrict.exit).toBe(1)
    expect(noStrict.lines).toEqual([expect.stringMatching(/does not list --strict-mcp-config$/)])
    expect(noMcp.exit).toBe(1)
    expect(noMcp.lines).toEqual([expect.stringMatching(/playwright-mcp --help exited 2/)])
    expect(passing).toEqual({ exit: 0, lines: ["city-filer: preflight ok"] })
  })
})
