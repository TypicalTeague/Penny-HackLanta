import { describe, expect, it } from "vitest";
import {
  MODEL_PORTFOLIOS,
  advancePortfolioWeek,
  contributeToPortfolio,
  createPortfolio,
  maxAllocationDriftBps,
  rebalancePortfolio,
  valueOf,
} from "../src/domain/portfolio.js";

describe("deterministic portfolio management", () => {
  it.each([
    ["low", [800, 2_400, 800]],
    ["medium", [2_400, 1_200, 400]],
    ["high", [3_400, 400, 200]],
  ] as const)("creates the configured %s-risk allocation", (risk, expected) => {
    const portfolio = createPortfolio("u", `p-${risk}`, 4_000, risk);
    expect(portfolio.positions.map((p) => p.valueCents)).toEqual(expected);
    expect(portfolio.positions.map((p) => p.targetWeightBps)).toEqual(
      Object.values(MODEL_PORTFOLIOS[risk]),
    );
    expect(valueOf(portfolio.positions)).toBe(4_000);
  });

  it("rebalances automatically above the configured drift threshold", () => {
    const portfolio = createPortfolio("u", "p", 10_000, "medium");
    portfolio.positions[0]!.valueCents = 8_000;
    portfolio.positions[1]!.valueCents = 1_000;
    portfolio.positions[2]!.valueCents = 1_000;
    expect(maxAllocationDriftBps(portfolio.positions)).toBe(2_000);
    const result = rebalancePortfolio(portfolio, 500);
    expect(result.rebalanced).toBe(true);
    expect(result.portfolio.positions.map((p) => p.valueCents)).toEqual([
      6_000, 3_000, 1_000,
    ]);
    expect(result.portfolio.rebalancingEvents).toHaveLength(1);
    expect(
      result.portfolio.transactions.some((t) => t.type === "rebalance"),
    ).toBe(true);
  });

  it("does not trade at or below the drift threshold", () => {
    const portfolio = createPortfolio("u", "p", 10_000, "medium");
    portfolio.positions[0]!.valueCents = 6_400;
    portfolio.positions[1]!.valueCents = 2_700;
    portfolio.positions[2]!.valueCents = 900;
    const result = rebalancePortfolio(portfolio, 500);
    expect(result.rebalanced).toBe(false);
    expect(result.portfolio.transactions).toHaveLength(3);
  });

  it("generates reproducible weekly snapshots", () => {
    const a = createPortfolio("u", "p", 4_000, "medium", 2_950);
    const b = createPortfolio("u", "p", 4_000, "medium", 2_950);
    expect(advancePortfolioWeek(a, 6_000)).toEqual(
      advancePortfolioWeek(b, 6_000),
    );
    expect(advancePortfolioWeek(a, 6_000).currentCents).toBe(4_118);
  });

  it("diversifies an approved simulated contribution", () => {
    const portfolio = createPortfolio("u", "p", 4_000, "medium");
    const updated = contributeToPortfolio(portfolio, 1_000);
    expect(updated.currentCents).toBe(5_000);
    expect(updated.positions.map((position) => position.valueCents)).toEqual([
      3_000, 1_500, 500,
    ]);
    expect(
      updated.transactions.filter((item) => item.type === "contribution"),
    ).toHaveLength(3);
  });
});
