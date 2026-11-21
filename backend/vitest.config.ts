import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    env: {
      NODE_ENV: "test",
      // Tests drive the stand-in WhatsApp provider directly; no random failures.
      MOCK_WHATSAPP_FAILURE_RATE: "0",
      MOCK_WHATSAPP_TIMEOUT_RATE: "0",
    },
    fileParallelism: false, // integration tests share one database
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
