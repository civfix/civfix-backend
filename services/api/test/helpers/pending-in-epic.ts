// Notification center epic (#211, D14): the contract snapshot carries these endpoints ahead of their
// routes. Each must stay unregistered while it is listed (route-coverage.test.ts checks it), so the
// sub-issue that registers one also removes it here, and the one that removes the last name deletes the
// set. csrf-pairing.test.ts leaves them out of the mutations it checks until then.
export const PENDING_IN_EPIC: ReadonlySet<string> = new Set([
  "unsubscribeNotificationEmail",
  "openUnsubscribeNotificationEmail",
])
