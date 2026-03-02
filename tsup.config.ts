import { defineConfig } from "tsup";
import { cpSync, mkdirSync } from "node:fs";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "node20",
  outDir: "dist",
  clean: true,
  sourcemap: true,
  dts: true,
  banner: {
    js: "#!/usr/bin/env node",
  },
  onSuccess: async () => {
    // Copy UI assets to dist/ui/ so the daemon can serve them
    mkdirSync("dist/ui", { recursive: true });
    cpSync("src/ui/index.html", "dist/ui/index.html");
  },
});
