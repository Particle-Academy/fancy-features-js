import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  clean: true,
  // Headless + framework-agnostic: no node/browser assumption, zero runtime deps.
  platform: "neutral",
  treeshake: true,
});
