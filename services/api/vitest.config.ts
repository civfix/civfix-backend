import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    // Unit tests must run with no external infra. Force all fakes on and a test NODE_ENV so the
    // env loader supplies safe defaults regardless of the developer's shell environment.
    env: {
      NODE_ENV: "test",
      USE_FAKE_STORAGE: "1",
      USE_FAKE_MAILER: "1",
      USE_FAKE_PUSH: "1",
      USE_FAKE_ABUSE_NSFW: "1",
      USE_FAKE_CHAT: "1",
      USE_FAKE_JOBS: "1",
    },
  },
})
