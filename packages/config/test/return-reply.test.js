import { describe, it, expect } from "vitest"
import { ESLint, RuleTester } from "eslint"
import tseslint from "typescript-eslint"
import rule, { message } from "../rules/return-reply.js"
import { config } from "../eslint.config.js"

RuleTester.describe = describe
RuleTester.it = it
RuleTester.itOnly = it.only

const tester = new RuleTester({ languageOptions: { parser: tseslint.parser } })
const error = { message }

tester.run("return-reply", rule, {
  valid: [
    { name: "T5: a returned send", code: "async (req, reply) => { return reply.send(x) }" },
    {
      name: "T6: a send in a sync function",
      code: "function h(req, reply) { reply.status(200).send(x) }",
    },
    {
      name: "T7: a send on a root other than reply",
      code: "async function h(socket, res) { socket.send(x); res.status(200).send(x) }",
    },
    {
      name: "T8: the nearest function is sync",
      code: "async function outer(reply) { function inner() { reply.send(x) } inner() }",
    },
    {
      name: "T9: an expression body and a send at module top level",
      code: "const h = async (req, reply) => reply.send(x)\nreply.send(x)",
    },
  ],
  invalid: [
    {
      name: "T1: a dropped chained send in an async arrow",
      code: "async (req, reply) => { reply.status(200).send(x) }",
      errors: [error],
    },
    {
      name: "T2: a chain on three lines",
      code: "async function h(req, reply) { reply\n.code(201)\n.send(x) }",
      errors: [error],
    },
    {
      name: "T3: sends in nested blocks",
      code: 'async function h(reply, ok) { if (ok) { reply.send(x) } else { try { reply.header("a", "b").send(y) } catch {} } }',
      errors: [error, error],
    },
    {
      name: "T4: an async handler inside a sync plugin, no argument",
      code: 'function plugin(app) { app.get("/", async (req, reply) => { reply.send() }) }',
      errors: [error],
    },
  ],
})

describe("the shared config", () => {
  it("T10: turns the rule on at error for src/**", async () => {
    const eslint = new ESLint({
      cwd: import.meta.dirname,
      overrideConfigFile: true,
      overrideConfig: config(),
    })
    const resolved = await eslint.calculateConfigForFile("src/routes/x.ts")
    expect(resolved.rules["civfix/return-reply"]).toEqual([2])
  })
})
