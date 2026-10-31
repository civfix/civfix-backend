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

// Both send the response themselves, so an async handler must return the reply either one gives back.
const SENDING_METHODS = new Set(["send", "redirect"])

function isReplySend(node) {
  if (node.type !== "CallExpression") return false
  const { callee } = node
  return (
    callee.type === "MemberExpression" &&
    !callee.computed &&
    callee.property.type === "Identifier" &&
    SENDING_METHODS.has(callee.property.name) &&
    rootIdentifier(callee.object) === "reply"
  )
}

// `await reply.send(x)` and `void reply.send(x)` still drop the reply.
function droppedCall(expression) {
  if (expression.type === "AwaitExpression") return expression.argument
  if (expression.type === "UnaryExpression" && expression.operator === "void") {
    return expression.argument
  }
  return expression
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
      ExpressionStatement(statement) {
        const node = droppedCall(statement.expression)
        if (isReplySend(node) && nearestFunctionIsAsync(context, node)) {
          context.report({ node, messageId: "returnReply" })
        }
      },
    }
  },
}
