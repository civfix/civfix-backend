import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const read = async (path: string): Promise<string> =>
  readFile(fileURLToPath(new URL(path, import.meta.url)), "utf8")

describe("the package", () => {
  it("T26: the playwright-core pin is the version CI installs Chromium with", async () => {
    const pkg = JSON.parse(await read("../../package.json")) as {
      dependencies: Record<string, string>
    }
    const ci = await read("../../../../.github/workflows/ci.yml")
    const installs = [...ci.matchAll(/npx --yes playwright-core@(\S+) install/g)].map((m) => m[1])

    expect(installs).toHaveLength(1)
    expect(pkg.dependencies["playwright-core"]).toBe(installs[0])
  })

  it("T29: the deploy keeps dist, kit, bin and playbook, and the kit is its own dependency-free ESM package", async () => {
    const pkg = JSON.parse(await read("../../package.json")) as { files: string[] }
    const kit = JSON.parse(await read("../../kit/package.json")) as Record<string, unknown>

    expect(pkg.files).toEqual(["dist", "kit", "bin", "playbook"])
    expect(kit).toMatchObject({ name: "@civfix/filer-kit", type: "module", exports: "./index.mjs" })
    expect(kit.dependencies).toBeUndefined()
  })
})
