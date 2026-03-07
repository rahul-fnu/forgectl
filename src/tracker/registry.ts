import type { TrackerAdapter, TrackerConfig } from "./types.js";

/**
 * Factory function that creates a TrackerAdapter from configuration.
 * Each tracker kind (github, notion, etc.) registers its own factory.
 */
export type TrackerAdapterFactory = (config: TrackerConfig) => TrackerAdapter;

const FACTORIES: Record<string, TrackerAdapterFactory> = {};

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
