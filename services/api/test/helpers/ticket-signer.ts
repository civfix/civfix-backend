import { makeTicketTokenSigner } from "../../src/services/host/ticket-token.js"

export const TEST_TICKET_TOKEN_SECRET = "test-ticket-token-secret-32-chars-min"

export const TEST_TICKET_SIGNER = makeTicketTokenSigner(TEST_TICKET_TOKEN_SECRET)
