import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const serverSource = readFileSync(
  join(import.meta.dirname, "..", "..", "src", "daemon", "server.ts"),
  "utf-8",
);

describe("daemon EventRecorder wiring", () => {
  it("imports createEventRepository from storage/repositories/events", () => {
    expect(serverSource).toMatch(
      /import\s*\{[^}]*createEventRepository[^}]*\}\s*from\s*["']\.\.\/storage\/repositories\/events\.js["']/,
    );
  });

  it("imports EventRecorder from logging/recorder", () => {
    expect(serverSource).toMatch(
      /import\s*\{[^}]*EventRecorder[^}]*\}\s*from\s*["']\.\.\/logging\/recorder\.js["']/,
    );
  });

  it("instantiates EventRecorder", () => {
    expect(serverSource).toContain("new EventRecorder(");
  });

  it("calls recorder.close() before closeDatabase", () => {
    const closeIdx = serverSource.indexOf("recorder.close()");
    const dbCloseIdx = serverSource.indexOf("closeDatabase(db)");
    expect(closeIdx).toBeGreaterThan(-1);
    expect(dbCloseIdx).toBeGreaterThan(-1);
    expect(closeIdx).toBeLessThan(dbCloseIdx);
  });
});
