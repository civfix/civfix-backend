export const message =
  'Return the reply: "return reply.send(...)". An async handler that drops it makes Fastify send twice.'

export default {
  meta: { type: "problem", schema: [], messages: { returnReply: message } },
  create() {
    throw new Error("not implemented")
  },
}
