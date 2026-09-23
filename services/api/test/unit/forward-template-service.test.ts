import { describe, it, expect } from "vitest"
import {
  DEFAULT_FORWARD_BODY_TEMPLATE,
  FORWARD_TEMPLATE_SAMPLE_VALUES,
  templateUsesToken,
} from "@civfix/shared"
import { InMemoryForwardTemplateRepository } from "../../src/services/admin/forward-template-repository.memory.js"
import {
  makeForwardTemplateService,
  type ForwardTemplateService,
} from "../../src/services/admin/forward-template-service.js"

interface Harness {
  repo: InMemoryForwardTemplateRepository
  svc: ForwardTemplateService
}

function harness(): Harness {
  const repo = new InMemoryForwardTemplateRepository()
  return { repo, svc: makeForwardTemplateService({ repo }) }
}

const sample = (name: string): string => FORWARD_TEMPLATE_SAMPLE_VALUES[name] ?? ""
const defaultBodyUses = (token: string): boolean =>
  templateUsesToken(DEFAULT_FORWARD_BODY_TEMPLATE, token)

describe("forward-template service: get + set", () => {
  it("returns an all-null settings DTO when no default has ever been saved", async () => {
    const { svc } = harness()
    expect(await svc.get()).toEqual({
      subjectTemplate: null,
      bodyTemplate: null,
      updatedAt: null,
    })
  })

  it("saves a default, records the actor, and reads it back", async () => {
    const { repo, svc } = harness()
    const saved = await svc.set(
      { subjectTemplate: "Ref {referenceCode}", bodyTemplate: "A {category} in {place}." },
      "op-1",
    )
    expect(saved.subjectTemplate).toBe("Ref {referenceCode}")
    expect(saved.bodyTemplate).toBe("A {category} in {place}.")
    expect(saved.updatedAt).toBe(repo.now.toISOString())
    expect(repo.writes.at(-1)?.actorId).toBe("op-1")
    expect(await svc.get()).toEqual(saved)
  })

  it("clears a field back to the built-in default when it arrives empty or null", async () => {
    const { repo, svc } = harness()
    await svc.set({ subjectTemplate: "Ref {referenceCode}", bodyTemplate: "Body." }, "op-1")
    const cleared = await svc.set({ subjectTemplate: "   ", bodyTemplate: null }, "op-1")
    expect(cleared.subjectTemplate).toBeNull()
    expect(cleared.bodyTemplate).toBeNull()
    expect(repo.writes.at(-1)).toMatchObject({ subjectTemplate: null, bodyTemplate: null })
  })
})

describe("forward-template service: preview", () => {
  it("renders the built-in default against the static sample when nothing is set", async () => {
    const { svc } = harness()
    const preview = await svc.preview({})
    expect(preview.subjectSource).toBe("builtin")
    expect(preview.bodySource).toBe("builtin")
    expect(preview.subject).toContain(sample("title"))
    expect(preview.subject).toContain(sample("referenceCode"))
    expect(preview.subject).not.toMatch(/\{[A-Za-z]+\}/)
    if (defaultBodyUses("referenceCode")) expect(preview.text).toContain(sample("referenceCode"))
    expect(`${preview.subject}\n${preview.text}`).toContain(sample("referenceCode"))
    if (defaultBodyUses("address")) expect(preview.text).toContain(sample("address"))
  })

  it("leaves no unresolved placeholder in the rendered preview", async () => {
    const { svc } = harness()
    const preview = await svc.preview({})
    expect(preview.text).not.toMatch(/\{[A-Za-z]+\}/)
    expect(preview.html).not.toMatch(/\{[A-Za-z]+\}/)
  })

  it("escapes the sample title in the HTML part", async () => {
    const { svc } = harness()
    const preview = await svc.preview({ subjectTemplate: null, bodyTemplate: "Title: {title}" })
    expect(preview.html).toContain("Title: Overflowing bin at 5th &amp; Main")
    expect(preview.html).not.toContain("5th & Main")
  })

  it("marks the stored default as the source when the request supplies nothing", async () => {
    const { svc } = harness()
    await svc.set({ subjectTemplate: "Stored {referenceCode}", bodyTemplate: null }, "op-1")
    const preview = await svc.preview({})
    expect(preview.subjectSource).toBe("default")
    expect(preview.bodySource).toBe("builtin")
    expect(preview.subject).toBe(`Stored ${sample("referenceCode")}`)
  })

  it("an unsaved draft in the request wins over the stored default and is marked custom", async () => {
    const { svc } = harness()
    await svc.set({ subjectTemplate: "Stored", bodyTemplate: "Stored body." }, "op-1")
    const preview = await svc.preview({
      subjectTemplate: "Draft {referenceCode}",
      bodyTemplate: "Draft body for {category}.",
    })
    expect(preview.subjectSource).toBe("custom")
    expect(preview.bodySource).toBe("custom")
    expect(preview.subject).toBe(`Draft ${sample("referenceCode")}`)
    expect(preview.text).toContain("Draft body for Trash.")
    expect(preview.text).not.toContain("Stored body.")
  })

  it("shows the sample photos and operator note the way a real packet would", async () => {
    const { svc } = harness()
    const preview = await svc.preview({})
    for (const href of sample("photoLinks").split("\n")) {
      expect(preview.html).toContain(href)
    }
    if (!defaultBodyUses("photoLinks")) {
      expect(preview.html).toContain(">Photo 1<")
      expect(preview.html).toContain(">Photo 2<")
    }
    expect(preview.text).toContain(sample("operatorNote"))
  })

  it("previews {photoLinks} as one numbered '- Photo <n>: <link>' line per sample photo", async () => {
    const { svc } = harness()
    const preview = await svc.preview({ subjectTemplate: null, bodyTemplate: "Links:\n{photoLinks}" })
    const urls = sample("photoLinks").split("\n")
    expect(urls.length).toBeGreaterThan(0)
    expect(preview.text).toContain(`Links:\n${urls.map((u, i) => `- Photo ${i + 1}: ${u}`).join("\n")}`)
    urls.forEach((u, i) => {
      expect(preview.html).toContain(`- Photo ${i + 1}: <a class="cv-link" href="${u}"`)
    })
  })

  it("appends the operator note WITHOUT a heading when the body does not render {operatorNote}", async () => {
    const { svc } = harness()
    const preview = await svc.preview({ subjectTemplate: null, bodyTemplate: "A {category} report." })
    expect(preview.text).toContain(`> ${sample("operatorNote")}`)
    expect(preview.text).not.toContain("Note from the civfix team")
    expect(preview.html).not.toContain("Note from the civfix team")
  })
})
