import { FakeMailer } from "@civfix/seams"
import { InMemoryNotificationEmailThrottle } from "../../src/adapters/notification-email-throttle.js"
import type { NotificationEmailDeps } from "../../src/services/notification-email.js"

/** What a fake container's getNotificationEmail hands the notification service: nothing leaves the box. */
export function fakeNotificationEmail(): NotificationEmailDeps {
  return {
    mailer: new FakeMailer(),
    throttle: new InMemoryNotificationEmailThrottle(),
    config: {
      from: "no-reply@civfix.test",
      webBaseUrl: "http://localhost:3000",
      apiBaseUrl: "http://localhost:8080",
      signingKey: "notification-email-test-signing-key-0123456789",
    },
  }
}
