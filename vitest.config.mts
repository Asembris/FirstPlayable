import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      "@fixtures": fileURLToPath(new URL("./fixtures", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["tests/engine/**/*.test.ts", "tests/server/**/*.test.ts"],
  },
});
