import { describe, it } from "vitest"
import { RuleTester } from "eslint"
import tseslint from "typescript-eslint"
import rule, { message } from "../rules/return-reply.js"

RuleTester.describe = describe
RuleTester.it = it
RuleTester.itOnly = it.only

const tester = new RuleTester({ languageOptions: { parser: tseslint.parser } })
const error = { message }

tester.run("return-reply: redirect, await and void", rule, {
  valid: [
    {
      name: "T20: a returned redirect",
      code: "async (req, reply) => { return reply.redirect(url) }",
    },
    {
      name: "T20: a redirect in a sync function",
      code: "function h(reply) { reply.redirect(url) }",
    },
    {
      name: "T20: a redirect on a root other than reply",
      code: "async function h(res) { res.redirect(url) }",
    },
    {
      name: "T22: a voided send in a sync function",
      code: "function h(reply) { void reply.send(x) }",
    },
    {
      name: "T22: an awaited send on a root other than reply",
      code: "async function h(socket) { await socket.send(x) }",
    },
  ],
  invalid: [
    {
      name: "T18: a dropped redirect in an async arrow",
      code: "async (req, reply) => { reply.redirect(url) }",
      errors: [error],
    },
    {
      name: "T19: a redirect chain on three lines",
      code: "async function h(req, reply) { reply\n.code(303)\n.redirect(url) }",
      errors: [error],
    },
    {
      name: "T21: an awaited send",
      code: "async (req, reply) => { await reply.send(x) }",
      errors: [error],
    },
    {
      name: "T21: a voided chained send",
      code: "async (req, reply) => { void reply.status(200).send(x) }",
      errors: [error],
    },
    {
      name: "T21: an awaited redirect",
      code: "async (req, reply) => { await reply.redirect(url) }",
      errors: [error],
    },
  ],
})
