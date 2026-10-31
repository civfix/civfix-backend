export const message =
  'Return the reply: "return reply.send(...)". An async handler that drops it makes Fastify send twice.'

const FUNCTION_TYPES = new Set([
  "FunctionDeclaration",
  "FunctionExpression",
  "ArrowFunctionExpression",
])

function rootIdentifier(node) {
  let current = node
  while (current.type === "MemberExpression" || current.type === "CallExpression") {
    current = current.type === "MemberExpression" ? current.object : current.callee
  }
  return current.type === "Identifier" ? current.name : null
}

function isReplySend(call) {
  const { callee } = call
  return (
    callee.type === "MemberExpression" &&
    !callee.computed &&
    callee.property.type === "Identifier" &&
    callee.property.name === "send" &&
    rootIdentifier(callee.object) === "reply"
  )
}

// A selector cannot say "the NEAREST enclosing function is async" (esquery has no nearest-ancestor
// match), and a send inside a sync callback nested in an async handler is legal, so this walks up.
function nearestFunctionIsAsync(context, node) {
  const fn = context.sourceCode.getAncestors(node).findLast((a) => FUNCTION_TYPES.has(a.type))
  return fn?.async === true
}

export default {
  meta: { type: "problem", schema: [], messages: { returnReply: message } },
  create(context) {
    return {
      "ExpressionStatement > CallExpression.expression"(node) {
        if (isReplySend(node) && nearestFunctionIsAsync(context, node)) {
          context.report({ node, messageId: "returnReply" })
        }
      },
    }
  },
}
