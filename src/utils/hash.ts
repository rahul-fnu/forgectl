import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export function hashString(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 12);
}

function hashFile(filePath: string): string {
  return hashString(readFileSync(filePath, "utf-8"));
}
