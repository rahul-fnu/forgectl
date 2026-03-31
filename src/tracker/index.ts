export type { TrackerAdapter, TrackerIssue, TrackerConfig } from "./types.js";
export { resolveToken } from "./token.js";
export { createTrackerAdapter, registerTrackerFactory } from "./registry.js";
// Note: importing registry.js triggers factory registration for github + notion
