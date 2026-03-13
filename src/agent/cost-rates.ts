/**
 * Default cost rates per model in USD per token.
 * Users can override these via config.
 */
export interface ModelRate {
  inputPerToken: number;
  outputPerToken: number;
}

/**
 * Default rate table: model name -> rate per token.
 * Prices are approximate and based on publicly available pricing as of early 2026.
 */
const DEFAULT_RATES: Record<string, ModelRate> = {
  // Claude models
  "claude-sonnet-4-20250514": { inputPerToken: 3 / 1_000_000, outputPerToken: 15 / 1_000_000 },
  "claude-opus-4-20250514": { inputPerToken: 15 / 1_000_000, outputPerToken: 75 / 1_000_000 },
  "claude-haiku-3-5": { inputPerToken: 0.8 / 1_000_000, outputPerToken: 4 / 1_000_000 },
  // Fallback aliases
  "claude-code": { inputPerToken: 3 / 1_000_000, outputPerToken: 15 / 1_000_000 },
  "codex": { inputPerToken: 3 / 1_000_000, outputPerToken: 15 / 1_000_000 },
  // OpenAI models
  "o3": { inputPerToken: 2 / 1_000_000, outputPerToken: 8 / 1_000_000 },
  "o4-mini": { inputPerToken: 1.1 / 1_000_000, outputPerToken: 4.4 / 1_000_000 },
  "gpt-4.1": { inputPerToken: 2 / 1_000_000, outputPerToken: 8 / 1_000_000 },
};

/** Default fallback rate when model is unknown. */
const FALLBACK_RATE: ModelRate = { inputPerToken: 3 / 1_000_000, outputPerToken: 15 / 1_000_000 };

/**
 * Look up the rate for a model. Falls back to agent-type default or generic rate.
 */
export function getModelRate(
  model: string | undefined,
  agentType?: string,
  overrides?: Record<string, ModelRate>,
): ModelRate {
  // Check user overrides first
  if (overrides && model && overrides[model]) {
    return overrides[model];
  }

  // Check default rates by model name
  if (model && DEFAULT_RATES[model]) {
    return DEFAULT_RATES[model];
  }

  // Fall back to agent type default
  if (agentType && DEFAULT_RATES[agentType]) {
    return DEFAULT_RATES[agentType];
  }

  return FALLBACK_RATE;
}

/**
 * Calculate cost in USD given token counts and a rate.
 */
export function calculateCost(
  inputTokens: number,
  outputTokens: number,
  rate: ModelRate,
): number {
  return inputTokens * rate.inputPerToken + outputTokens * rate.outputPerToken;
}
