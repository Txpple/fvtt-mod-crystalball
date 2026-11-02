import { defineConfig } from "vitest/config";

// The one gate for both halves: the module's pure pieces under tests/, the Seer's under seer/tests/.
export default defineConfig({
  test: {
    globals: true,
    include: ["tests/**/*.test.js", "seer/tests/**/*.test.js"],
    environment: "node"
  }
});
