import type { UsageTotals } from "./types.js";

export interface TokenRates {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
}

export interface ModelPricing extends TokenRates {
  /** Rates applied when one request's prompt exceeds ABOVE_100K_THRESHOLD tokens. */
  above100k?: TokenRates;
}

const LITELLM_PRICES_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";

const ABOVE_100K_THRESHOLD = 100_000;

// USD per token. Snapshot from the official pricing page and LiteLLM model_prices_and_context_window.json (2026-11-13).
export const DEFAULT_PRICING: Record<string, ModelPricing> = {
  "claude-fable-5-2": {
    input: 8e-6,
    output: 4e-5,
    cacheRead: 2e-7,
    cacheWrite5m: 1e-5,
    cacheWrite1h: 1.6e-5,
  },
  "claude-fable-5-1": {
    input: 1e-5,
    output: 5e-5,
    cacheRead: 2.5e-7,
    cacheWrite5m: 1.25e-5,
    cacheWrite1h: 2e-5,
  },
  "claude-opus-5-5": {
    input: 4e-6,
    output: 2e-5,
    cacheRead: 2e-7,
    cacheWrite5m: 5e-6,
    cacheWrite1h: 8e-6,
  },
  "claude-sonnet-5-5": {
    input: 2e-6,
    output: 1e-5,
    cacheRead: 1e-7,
    cacheWrite5m: 2.5e-6,
    cacheWrite1h: 4e-6,
  },
  "claude-haiku-5-5": {
    input: 1e-7,
    output: 5e-7,
    cacheRead: 1e-8,
    cacheWrite5m: 1.25e-7,
    cacheWrite1h: 2e-7,
    above100k: {
      input: 5e-7,
      output: 2.5e-6,
      cacheRead: 5e-8,
      cacheWrite5m: 6.25e-7,
      cacheWrite1h: 1e-6,
    },
  },
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

const PROVIDER_PREFIXES = new Set([
  "bedrock",
  "anthropic",
  "vertex",
  "openrouter",
  "aws",
]);

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
  input_cost_per_token_above_100k_tokens?: number;
  output_cost_per_token_above_100k_tokens?: number;
  cache_read_input_token_cost_above_100k_tokens?: number;
  cache_creation_input_token_cost_above_100k_tokens?: number;
  cache_creation_input_token_cost_above_1hr_above_100k_tokens?: number;
}

export class PricingTable {
  private readonly table: Map<string, ModelPricing>;
  private readonly liteLLMKeys = new Set<string>();
  private refreshedAt: string | undefined;

  constructor(seed: Record<string, ModelPricing> = DEFAULT_PRICING) {
    this.table = new Map(Object.entries(seed));
  }

  /** Resolves the matching table key for a model name, or undefined if none match. */
  private resolveKey(model: string): string | undefined {
    if (this.table.has(model)) return model;

    const withoutDate = model.replace(/-\d{8}$/, "");
    if (this.table.has(withoutDate)) return withoutDate;

    let bestKey = "";
    for (const key of this.table.keys()) {
      if (model.startsWith(key) && key.length > bestKey.length) bestKey = key;
    }
    if (bestKey) return bestKey;

    // 4th pass: token-set match — handles provider-prefixed custom names
    // e.g. "bedrock-claude-5-sonnet" ↔ "claude-sonnet-5"
    const needle = tokenKey(model);
    if (needle) {
      for (const key of this.table.keys()) {
        if (tokenKey(key) === needle) return key;
      }
    }
    return undefined;
  }

  resolve(model: string): ModelPricing | undefined {
    const key = this.resolveKey(model);
    return key === undefined ? undefined : this.table.get(key);
  }

  /**
   * Identifies where a model's currently-resolved pricing came from — persisted
   * alongside a computed cost so a stored rate can be attributed later even if
   * the table has since moved on. Undefined when the model has no pricing at
   * all (mirrors resolve()).
   */
  pricingSource(model: string): string | undefined {
    const key = this.resolveKey(model);
    if (key === undefined) return undefined;
    if (this.liteLLMKeys.has(key) && this.refreshedAt) {
      return `litellm@${this.refreshedAt}`;
    }
    return "embedded";
  }

  // shortcut: the tier is evaluated on the summed message usage; a multi-iteration message (server tools) could straddle 100K — price per iteration if that ever matters.
  /**
   * Effective rates for one request: the above-100K tier when its prompt
   * (input + cache reads + cache writes) exceeds 100K tokens, else base rates.
   */
  ratesFor(model: string, usage: UsageTotals): TokenRates | undefined {
    const pricing = this.resolve(model);
    if (!pricing) return undefined;
    const prompt =
      usage.inputTokens +
      usage.cacheReadTokens +
      usage.cacheWrite5mTokens +
      usage.cacheWrite1hTokens;
    return pricing.above100k && prompt > ABOVE_100K_THRESHOLD
      ? pricing.above100k
      : pricing;
  }

  costUSD(model: string, usage: UsageTotals): number {
    const rates = this.ratesFor(model, usage);
    if (!rates) return 0;
    return (
      usage.inputTokens * rates.input +
      usage.outputTokens * rates.output +
      usage.cacheReadTokens * rates.cacheRead +
      usage.cacheWrite5mTokens * rates.cacheWrite5m +
      usage.cacheWrite1hTokens * rates.cacheWrite1h
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
        const above100k: TokenRates | undefined =
          typeof entry.input_cost_per_token_above_100k_tokens === "number"
            ? {
                input: entry.input_cost_per_token_above_100k_tokens,
                output: entry.output_cost_per_token_above_100k_tokens ?? 0,
                cacheRead:
                  entry.cache_read_input_token_cost_above_100k_tokens ?? 0,
                cacheWrite5m:
                  entry.cache_creation_input_token_cost_above_100k_tokens ?? 0,
                cacheWrite1h:
                  entry.cache_creation_input_token_cost_above_1hr_above_100k_tokens ??
                  entry.cache_creation_input_token_cost_above_100k_tokens ??
                  0,
              }
            : undefined;
        this.table.set(canonicalKey, {
          input: entry.input_cost_per_token,
          output: entry.output_cost_per_token,
          cacheRead: entry.cache_read_input_token_cost ?? 0,
          cacheWrite5m: entry.cache_creation_input_token_cost ?? 0,
          cacheWrite1h:
            entry.cache_creation_input_token_cost_above_1hr ??
            entry.cache_creation_input_token_cost ??
            0,
          above100k,
        });
        this.liteLLMKeys.add(canonicalKey);
        updated += 1;
      }
      if (updated > 0) this.refreshedAt = new Date().toISOString();
      return updated;
    } catch {
      return 0;
    }
  }
}
