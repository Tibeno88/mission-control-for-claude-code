import { afterEach, describe, expect, test, vi } from "vitest";
import { PricingTable } from "../src/pricing.js";
import type { UsageTotals } from "../src/types.js";

const usage = (partial: Partial<UsageTotals>): UsageTotals => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWrite5mTokens: 0,
  cacheWrite1hTokens: 0,
  ...partial,
});

describe("PricingTable.resolve", () => {
  const table = new PricingTable();

  test("resolves exact model id", () => {
    expect(table.resolve("claude-fable-5")?.input).toBe(1e-5);
  });

  test("resolves dated snapshot id by stripping the date suffix", () => {
    expect(table.resolve("claude-sonnet-4-5-20250929")?.input).toBe(3e-6);
  });

  test("resolves unknown snapshot via longest prefix", () => {
    expect(table.resolve("claude-opus-4-8-20261201")?.input).toBe(5e-6);
  });

  test("returns undefined for unknown model families", () => {
    expect(table.resolve("gpt-9-mega")).toBeUndefined();
  });

  test.each([
    [
      "claude-fable-5-2",
      {
        input: 8e-6,
        output: 4e-5,
        cacheRead: 2e-7,
        cacheWrite5m: 1e-5,
        cacheWrite1h: 1.6e-5,
      },
    ],
    [
      "claude-fable-5-1",
      {
        input: 1e-5,
        output: 5e-5,
        cacheRead: 2.5e-7,
        cacheWrite5m: 1.25e-5,
        cacheWrite1h: 2e-5,
      },
    ],
    [
      "claude-opus-5-5",
      {
        input: 4e-6,
        output: 2e-5,
        cacheRead: 2e-7,
        cacheWrite5m: 5e-6,
        cacheWrite1h: 8e-6,
      },
    ],
    [
      "claude-sonnet-5-5",
      {
        input: 2e-6,
        output: 1e-5,
        cacheRead: 1e-7,
        cacheWrite5m: 2.5e-6,
        cacheWrite1h: 4e-6,
      },
    ],
    [
      "claude-haiku-5-5",
      {
        input: 1e-7,
        output: 5e-7,
        cacheRead: 1e-8,
        cacheWrite5m: 1.25e-7,
        cacheWrite1h: 2e-7,
      },
    ],
  ])("resolves %s exactly to its base rates", (model, rates) => {
    expect(table.resolve(model)).toMatchObject(rates);
  });

  test("resolves claude-haiku-5-5 with the above-100K tier", () => {
    expect(table.resolve("claude-haiku-5-5")?.above100k).toEqual({
      input: 5e-7,
      output: 2.5e-6,
      cacheRead: 5e-8,
      cacheWrite5m: 6.25e-7,
      cacheWrite1h: 1e-6,
    });
  });
});

describe("PricingTable.ratesFor", () => {
  const table = new PricingTable();
  const haikuBase = table.resolve("claude-haiku-5-5");
  const haikuHigh = table.resolve("claude-haiku-5-5")?.above100k;

  test("returns base rates when the prompt is at most 100K tokens", () => {
    expect(
      table.ratesFor("claude-haiku-5-5", usage({ inputTokens: 50_000 })),
    ).toEqual(haikuBase);
  });

  test("returns base rates when the prompt is exactly 100K tokens", () => {
    expect(
      table.ratesFor("claude-haiku-5-5", usage({ inputTokens: 100_000 })),
    ).toEqual(haikuBase);
  });

  test("returns above-100K rates when the prompt exceeds 100K tokens", () => {
    expect(
      table.ratesFor("claude-haiku-5-5", usage({ inputTokens: 150_000 })),
    ).toEqual(haikuHigh);
  });

  test("counts cache reads and writes toward the prompt length", () => {
    expect(
      table.ratesFor(
        "claude-haiku-5-5",
        usage({
          inputTokens: 40_000,
          cacheReadTokens: 50_000,
          cacheWrite5mTokens: 5_000,
          cacheWrite1hTokens: 5_001,
        }),
      ),
    ).toEqual(haikuHigh);
  });

  test("ignores output tokens when choosing the tier", () => {
    expect(
      table.ratesFor(
        "claude-haiku-5-5",
        usage({ inputTokens: 10, outputTokens: 500_000 }),
      ),
    ).toEqual(haikuBase);
  });

  test("returns base rates for a model without an above-100K tier", () => {
    expect(
      table.ratesFor("claude-sonnet-5-5", usage({ inputTokens: 150_000 })),
    ).toEqual(table.resolve("claude-sonnet-5-5"));
  });

  test("returns undefined for unknown models", () => {
    expect(
      table.ratesFor("mystery-model", usage({ inputTokens: 1 })),
    ).toBeUndefined();
  });
});

describe("PricingTable.costUSD", () => {
  const table = new PricingTable();

  test("computes cost across all buckets for claude-fable-5", () => {
    const cost = table.costUSD(
      "claude-fable-5",
      usage({
        inputTokens: 1000,
        outputTokens: 2000,
        cacheReadTokens: 10_000,
        cacheWrite5mTokens: 4000,
        cacheWrite1hTokens: 5000,
      }),
    );
    // 1000*1e-5 + 2000*5e-5 + 10000*1e-6 + 4000*1.25e-5 + 5000*2e-5 = 0.27
    expect(cost).toBeCloseTo(0.27, 10);
  });

  test("prices claude-haiku-5-5 at base rates for a 50K-token prompt", () => {
    const cost = table.costUSD(
      "claude-haiku-5-5",
      usage({ inputTokens: 50_000 }),
    );
    // 50000 * 1e-7
    expect(cost).toBeCloseTo(0.005, 12);
  });

  test("prices claude-haiku-5-5 at above-100K rates for a 150K-token prompt", () => {
    const cost = table.costUSD(
      "claude-haiku-5-5",
      usage({ inputTokens: 150_000 }),
    );
    // 150000 * 5e-7
    expect(cost).toBeCloseTo(0.075, 12);
  });

  test("returns 0 for unknown models instead of guessing", () => {
    expect(
      table.costUSD("mystery-model", usage({ inputTokens: 1_000_000 })),
    ).toBe(0);
  });
});

describe("PricingTable.refreshFromLiteLLM", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const stubLiteLLM = (data: Record<string, unknown>): void => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(data))),
    );
  };

  test("fills above100k from the LiteLLM *_above_100k_tokens fields", async () => {
    stubLiteLLM({
      "claude-haiku-5-5": {
        input_cost_per_token: 1e-7,
        output_cost_per_token: 5e-7,
        cache_read_input_token_cost: 1e-8,
        cache_creation_input_token_cost: 1.25e-7,
        cache_creation_input_token_cost_above_1hr: 2e-7,
        input_cost_per_token_above_100k_tokens: 5e-7,
        output_cost_per_token_above_100k_tokens: 2.5e-6,
        cache_read_input_token_cost_above_100k_tokens: 5e-8,
        cache_creation_input_token_cost_above_100k_tokens: 6.25e-7,
        cache_creation_input_token_cost_above_1hr_above_100k_tokens: 1e-6,
      },
    });
    const table = new PricingTable();

    await table.refreshFromLiteLLM();

    expect(table.resolve("claude-haiku-5-5")?.above100k).toEqual({
      input: 5e-7,
      output: 2.5e-6,
      cacheRead: 5e-8,
      cacheWrite5m: 6.25e-7,
      cacheWrite1h: 1e-6,
    });
  });

  test("falls back to the 5m above-100K price for the 1h write tier", async () => {
    stubLiteLLM({
      "claude-opus-5-5": {
        input_cost_per_token: 4e-6,
        output_cost_per_token: 2e-5,
        input_cost_per_token_above_100k_tokens: 8e-6,
        output_cost_per_token_above_100k_tokens: 4e-5,
        cache_creation_input_token_cost_above_100k_tokens: 1e-5,
      },
    });
    const table = new PricingTable();

    await table.refreshFromLiteLLM();

    expect(table.resolve("claude-opus-5-5")?.above100k).toEqual({
      input: 8e-6,
      output: 4e-5,
      cacheRead: 0,
      cacheWrite5m: 1e-5,
      cacheWrite1h: 1e-5,
    });
  });

  test("leaves above100k undefined when the tier input price is absent", async () => {
    stubLiteLLM({
      "claude-sonnet-5-5": {
        input_cost_per_token: 2e-6,
        output_cost_per_token: 1e-5,
      },
    });
    const table = new PricingTable();

    await table.refreshFromLiteLLM();

    expect(table.resolve("claude-sonnet-5-5")?.above100k).toBeUndefined();
  });
});
