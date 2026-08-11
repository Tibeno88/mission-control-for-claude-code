import type { UsageTotals } from "./types.js";

export interface ModelPricing {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
}

const LITELLM_PRICES_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";

// USD per token. Snapshot from LiteLLM model_prices_and_context_window.json (2026-07-13).
export const DEFAULT_PRICING: Record<string, ModelPricing> = {
  "claude-fable-5": {
    input: 1e-5,
    output: 5e-5,
    cacheRead: 1e-6,
    cacheWrite5m: 1.25e-5,
    cacheWrite1h: 2e-5,
  },
  "claude-sonnet-5": {
    input: 2e-6,
    output: 1e-5,
    cacheRead: 2e-7,
    cacheWrite5m: 2.5e-6,
    cacheWrite1h: 4e-6,
  },
  "claude-sonnet-4-6": {
    input: 3e-6,
    output: 1.5e-5,
    cacheRead: 3e-7,
    cacheWrite5m: 3.75e-6,
    cacheWrite1h: 6e-6,
  },
  "claude-sonnet-4-5": {
    input: 3e-6,
    output: 1.5e-5,
    cacheRead: 3e-7,
    cacheWrite5m: 3.75e-6,
    cacheWrite1h: 6e-6,
  },
  "claude-sonnet-4": {
    input: 3e-6,
    output: 1.5e-5,
    cacheRead: 3e-7,
    cacheWrite5m: 3.75e-6,
    cacheWrite1h: 6e-6,
  },
  "claude-opus-4-8": {
    input: 5e-6,
    output: 2.5e-5,
    cacheRead: 5e-7,
    cacheWrite5m: 6.25e-6,
    cacheWrite1h: 1e-5,
  },
  "claude-opus-4-7": {
    input: 5e-6,
    output: 2.5e-5,
    cacheRead: 5e-7,
    cacheWrite5m: 6.25e-6,
    cacheWrite1h: 1e-5,
  },
  "claude-opus-4-6": {
    input: 5e-6,
    output: 2.5e-5,
    cacheRead: 5e-7,
    cacheWrite5m: 6.25e-6,
    cacheWrite1h: 1e-5,
  },
  "claude-opus-4-5": {
    input: 5e-6,
    output: 2.5e-5,
    cacheRead: 5e-7,
    cacheWrite5m: 6.25e-6,
    cacheWrite1h: 1e-5,
  },
  "claude-opus-4-1": {
    input: 1.5e-5,
    output: 7.5e-5,
    cacheRead: 1.5e-6,
    cacheWrite5m: 1.875e-5,
    cacheWrite1h: 3e-5,
  },
  "claude-opus-4": {
    input: 1.5e-5,
    output: 7.5e-5,
    cacheRead: 1.5e-6,
    cacheWrite5m: 1.875e-5,
    cacheWrite1h: 3e-5,
  },
  "claude-haiku-4-5": {
    input: 1e-6,
    output: 5e-6,
    cacheRead: 1e-7,
    cacheWrite5m: 1.25e-6,
    cacheWrite1h: 2e-6,
  },
};

const PROVIDER_PREFIXES = new Set(["bedrock", "anthropic", "vertex", "openrouter", "aws"]);

/**
 * Normalizes a model name to a sorted token key for fuzzy matching.
 * Strips provider prefixes and date suffixes so that
 * "bedrock-claude-5-sonnet" and "claude-sonnet-5" produce identical keys.
 * Returns undefined when fewer than 2 meaningful tokens remain (avoids false positives).
 */
function tokenKey(model: string): string | undefined {
  const tokens = model
    .toLowerCase()
    .split(/[-/_]/)
    .filter((t) => {
      if (t.length < 2) return false;
      if (/^\d{8}$/.test(t)) return false; // date suffix
      if (PROVIDER_PREFIXES.has(t)) return false;
      return true;
    });
  if (tokens.length < 2) return undefined;
  return tokens.sort().join("-");
}

interface LiteLLMEntry {
  input_cost_per_token?: number;
  output_cost_per_token?: number;
  cache_read_input_token_cost?: number;
  cache_creation_input_token_cost?: number;
  cache_creation_input_token_cost_above_1hr?: number;
}

export class PricingTable {
  private readonly table: Map<string, ModelPricing>;

  constructor(seed: Record<string, ModelPricing> = DEFAULT_PRICING) {
    this.table = new Map(Object.entries(seed));
  }

  resolve(model: string): ModelPricing | undefined {
    const exact = this.table.get(model);
    if (exact) return exact;

    const withoutDate = model.replace(/-\d{8}$/, "");
    const dateless = this.table.get(withoutDate);
    if (dateless) return dateless;

    let bestKey = "";
    for (const key of this.table.keys()) {
      if (model.startsWith(key) && key.length > bestKey.length) bestKey = key;
    }
    if (bestKey) return this.table.get(bestKey);

    // 4th pass: token-set match — handles provider-prefixed custom names
    // e.g. "bedrock-claude-5-sonnet" ↔ "claude-sonnet-5"
    const needle = tokenKey(model);
    if (needle) {
      for (const [key, pricing] of this.table) {
        if (tokenKey(key) === needle) return pricing;
      }
    }
    return undefined;
  }

  costUSD(model: string, usage: UsageTotals): number {
    const pricing = this.resolve(model);
    if (!pricing) return 0;
    return (
      usage.inputTokens * pricing.input +
      usage.outputTokens * pricing.output +
      usage.cacheReadTokens * pricing.cacheRead +
      usage.cacheWrite5mTokens * pricing.cacheWrite5m +
      usage.cacheWrite1hTokens * pricing.cacheWrite1h
    );
  }

  /**
   * Best-effort refresh from LiteLLM's community pricing table.
   * Never throws: the embedded snapshot remains the fallback offline.
   * Returns the number of models updated.
   */
  async refreshFromLiteLLM(timeoutMs = 5000): Promise<number> {
    try {
      const response = await fetch(LITELLM_PRICES_URL, {
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) return 0;
      const data = (await response.json()) as Record<string, LiteLLMEntry>;
      let updated = 0;
      for (const [key, entry] of Object.entries(data)) {
        const isClaudeKey =
          key.startsWith("claude-") ||
          key.startsWith("bedrock/claude-") ||
          key.startsWith("vertex_ai/claude-");
        if (!isClaudeKey) continue;
        if (
          typeof entry.input_cost_per_token !== "number" ||
          typeof entry.output_cost_per_token !== "number"
        ) {
          continue;
        }
        const canonicalKey = key.replace(/^(?:bedrock|vertex_ai)\//, "");
        this.table.set(canonicalKey, {
          input: entry.input_cost_per_token,
          output: entry.output_cost_per_token,
          cacheRead: entry.cache_read_input_token_cost ?? 0,
          cacheWrite5m: entry.cache_creation_input_token_cost ?? 0,
          cacheWrite1h:
            entry.cache_creation_input_token_cost_above_1hr ??
            entry.cache_creation_input_token_cost ??
            0,
        });
        updated += 1;
      }
      return updated;
    } catch {
      return 0;
    }
  }
}
