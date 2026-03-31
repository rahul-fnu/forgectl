import type { TrackerAdapter, TrackerConfig } from "./types.js";
import { createGitHubAdapter } from "./github.js";
import { createNotionAdapter } from "./notion.js";
import { createLinearAdapter } from "./linear.js";

/**
 * Factory function that creates a TrackerAdapter from configuration.
 * Each tracker kind (github, notion, linear, etc.) registers its own factory.
 */
export type TrackerAdapterFactory = (config: TrackerConfig) => TrackerAdapter;

const FACTORIES: Record<string, TrackerAdapterFactory> = {};

// Register built-in adapter factories
registerTrackerFactory("github", createGitHubAdapter);
registerTrackerFactory("notion", createNotionAdapter);
registerTrackerFactory("linear", createLinearAdapter);

/**
 * Register a factory for a tracker kind.
 * Called by adapter modules to make themselves available.
 */
export function registerTrackerFactory(
  kind: string,
  factory: TrackerAdapterFactory,
): void {
  FACTORIES[kind] = factory;
}

/**
 * Create a TrackerAdapter instance from config.
 * Looks up the factory by config.kind and calls it.
 *
 * @throws if no factory is registered for the given kind
 */
export function createTrackerAdapter(config: TrackerConfig): TrackerAdapter {
  const factory = FACTORIES[config.kind];
  if (!factory) {
    const available = Object.keys(FACTORIES).join(", ");
    throw new Error(
      `Tracker: unknown kind "${config.kind}". Available: ${available}`,
    );
  }
  return factory(config);
}
