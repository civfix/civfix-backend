import { createServer, type IncomingMessage } from "node:http"
import type { AddressInfo } from "node:net"

/**
 * A city portal stand-in for the fixture script: a form whose submit confirms a request number, a
 * "similar request" page, a page with no form, a submit that errors and one that confirms a bad number.
 */
export type PortalMode = "normal" | "similar" | "no_form" | "submit_error" | "bad_case_id"

export interface FixturePortal {
  formUrl: string
  mode: PortalMode
  readonly submissions: Record<string, string>[]
  close(): Promise<void>
}

const page = (body: string): string =>
  `<!doctype html><html><head><title>Portal</title></head><body>${body}</body></html>`

const FORM = page(`
  <h1>Report a problem</h1>
  <form method="post" action="/submit">
    <textarea name="description"></textarea>
    <input name="email">
    <button id="submit" type="submit">Submit</button>
  </form>`)

function readBody(req: IncomingMessage): Promise<Record<string, string>> {
  return new Promise((resolve, reject) => {
    let raw = ""
    req.setEncoding("utf8")
    req.on("data", (chunk: string) => (raw += chunk))
    req.on("end", () => resolve(Object.fromEntries(new URLSearchParams(raw))))
    req.on("error", reject)
  })
}

export async function startFixturePortal(): Promise<FixturePortal> {
  const submissions: Record<string, string>[] = []
  const portal = { mode: "normal" as PortalMode }
  const server = createServer((req, res) => {
    void (async () => {
      res.setHeader("content-type", "text/html; charset=utf-8")
      if (req.method === "GET" && req.url === "/form") {
        if (portal.mode === "similar") {
          res.end(page(`<p id="similar">Review Similar Request SR-0042</p>`))
        } else if (portal.mode === "no_form") {
          res.end(page(`<p>Down for maintenance</p>`))
        } else {
          res.end(FORM)
        }
        return
      }
      if (req.method === "POST" && req.url === "/submit") {
        submissions.push(await readBody(req))
        if (portal.mode === "submit_error") {
          res.statusCode = 500
          res.end(page(`<p id="error">Something went wrong</p>`))
        } else if (portal.mode === "bad_case_id") {
          res.end(page(`<p>Your request number is <span id="case">&lt;b&gt;</span></p>`))
        } else {
          res.end(page(`<p>Your request number is <span id="case">SR-0001</span></p>`))
        }
        return
      }
      res.statusCode = 404
      res.end(page("Not found"))
    })()
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const { port } = server.address() as AddressInfo
  return Object.assign(portal, {
    formUrl: `http://127.0.0.1:${port}/form`,
    submissions,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  })
}
