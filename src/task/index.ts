export type {
  TaskSpec,
  TaskContext,
  AcceptanceCriterion,
  DecompositionConfig,
  EffortConfig,
  TaskValidationResult,
  TaskValidationError,
  TaskValidationWarning,
  ScaffoldOptions,
} from "./types.js";
export { TaskSpecSchema, ValidatedTaskSpec } from "./schema.js";
export { loadTaskSpec, loadTaskSpecFromString, findTaskSpecs } from "./loader.js";
export { validateTaskSpec } from "./validator.js";
export { scaffoldTaskSpec } from "./scaffold.js";
export type { DecompositionStrategy, DecompositionResult } from "./decomposition.js";
export { ModuleBoundaryStrategy, decompose } from "./decomposition.js";
