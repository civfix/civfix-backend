import { describe, it, expect } from "vitest"
import { R2Storage, R2_PUT_TTL_SEC } from "../../src/adapters/storage.r2.js"

/**
 * The AWS SigV4 presigner computes URLs locally (it never calls R2), so presignPut/presignGet can be
 * asserted offline against fake creds. head/delete/put DO hit the network and are exercised only against
 * real R2 in deployment.
 */

const config = {
  accountId: "acct123",
  accessKeyId: "AKIAEXAMPLE",
  secretAccessKey: "secretEXAMPLE",
  bucket: "civfix-media",
}

describe("R2Storage.presignPut", () => {
  it("returns a signed PUT URL against the account endpoint + bucket, with echo headers", async () => {
    const storage = new R2Storage(config)
    const res = await storage.presignPut("uploads/2026/05/abc", {
      contentType: "image/jpeg",
      byteSize: 1234,
    })

    expect(res.url).toContain(
      "https://acct123.r2.cloudflarestorage.com/civfix-media/uploads/2026/05/abc",
    )
    expect(res.url).toContain("X-Amz-Signature=")
    expect(res.url).toContain(`X-Amz-Expires=${R2_PUT_TTL_SEC}`)
    // content-length is part of the signed headers (the size is pinned).
    expect(res.url).toContain("X-Amz-SignedHeaders=content-length%3Bhost")
    // No auto checksum baked into the presigned PUT (would break a raw-client upload to R2).
    expect(res.url).not.toContain("x-amz-checksum")

    // The headers the client MUST echo (both are signed).
    expect(res.headers["content-type"]).toBe("image/jpeg")
    expect(res.headers["content-length"]).toBe("1234")
  })
})

describe("R2Storage.presignGet", () => {
  it("returns a time-limited signed GET URL when no publicBase is configured", async () => {
    const storage = new R2Storage(config)
    const url = await storage.presignGet("uploads/2026/05/abc", 600)
    expect(url).toContain(
      "https://acct123.r2.cloudflarestorage.com/civfix-media/uploads/2026/05/abc",
    )
    expect(url).toContain("X-Amz-Signature=")
    expect(url).toContain("X-Amz-Expires=600")
  })

  it("returns the public CDN URL (no signing) when publicBase is set", async () => {
    const storage = new R2Storage({ ...config, publicBase: "https://cdn.civfix.org" })
    const url = await storage.presignGet("uploads/2026/05/abc", 600)
    expect(url).toBe("https://cdn.civfix.org/uploads/2026/05/abc")
  })

  it("joins publicBase and key with exactly one slash (trailing slash tolerated)", async () => {
    const storage = new R2Storage({ ...config, publicBase: "https://cdn.civfix.org/" })
    const url = await storage.presignGet("/uploads/x", 600)
    expect(url).toBe("https://cdn.civfix.org/uploads/x")
  })

  it("prepends https:// to a scheme-less publicBase (so the URL is absolute, not page-relative)", async () => {
    // Guards the misconfig that produced https://civfix.org/pin/cdn.civfix.org/uploads/... : a
    // scheme-less "cdn.civfix.org" was joined into a relative url and resolved against the page.
    const storage = new R2Storage({ ...config, publicBase: "cdn.civfix.org" })
    const url = await storage.presignGet("uploads/2026/06/abc", 600)
    expect(url).toBe("https://cdn.civfix.org/uploads/2026/06/abc")
  })
})
