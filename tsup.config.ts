import { defineConfig } from "tsup";
import { cpSync } from "node:fs";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "node20",
  outDir: "dist",
  clean: true,
  sourcemap: true,
  dts: true,
  external: ["better-sqlite3"],
  banner: {
    js: "#!/usr/bin/env node",
  },
  onSuccess: async () => {
    // Copy Drizzle migrations to dist/ so they ship with the bundle
    try {
      cpSync("drizzle", "dist/drizzle", { recursive: true });
    } catch {
      // drizzle/ folder may not exist during early development
    }
  },
});
