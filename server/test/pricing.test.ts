import { describe, expect, test } from "vitest";
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

  test("returns 0 for unknown models instead of guessing", () => {
    expect(
      table.costUSD("mystery-model", usage({ inputTokens: 1_000_000 })),
    ).toBe(0);
  });
});
