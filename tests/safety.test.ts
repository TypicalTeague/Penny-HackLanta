import { describe, expect, it } from "vitest";
import { evaluateSafety } from "../src/domain/safety.js";
import type { Expense } from "../src/domain/types.js";

const now = new Date("2026-10-11T12:00:00Z");
const expense = (
  amountCents: number,
  horizonDays: number,
  essential = true,
  label = "rent",
): Expense => ({ id: "e1", label, amountCents, horizonDays, essential });

describe("deterministic safety engine", () => {
  it("protects an essential expense within 90 days", () => {
    const result = evaluateSafety(
      {
        availableCashCents: 10_000,
        expenses: [expense(6_000, 60, true, "textbooks")],
        riskPreference: "unknown",
      },
      now,
    );
    expect(result).toMatchObject({
      protectedCashCents: 6_000,
      investableCashCents: 4_000,
      decision: "propose",
    });
    expect(result.reasonCodes).toContain("PROTECT_NEAR_TERM_ESSENTIAL");
  });
  it("can safely determine zero", () => {
    const result = evaluateSafety(
      {
        availableCashCents: 10_000,
        expenses: [expense(10_000, 7)],
        riskPreference: "high",
      },
      now,
    );
    expect(result.investableCashCents).toBe(0);
    expect(result.reasonCodes).toEqual([
      "PROTECT_NEAR_TERM_ESSENTIAL",
      "NO_CAPACITY_AFTER_PROTECTION",
      "RISK_CANNOT_OVERRIDE_CAPACITY",
    ]);
  });
  it("does not protect nonessential or distant expenses", () => {
    const result = evaluateSafety(
      {
        availableCashCents: 10_000,
        expenses: [expense(6_000, 91), expense(2_000, 5, false)],
        riskPreference: "medium",
      },
      now,
    );
    expect(result).toMatchObject({
      protectedCashCents: 0,
      investableCashCents: 10_000,
    });
  });
  it("never exceeds available cash even when expenses do", () => {
    const result = evaluateSafety(
      {
        availableCashCents: 5_000,
        expenses: [expense(12_000, 10)],
        riskPreference: "unknown",
      },
      now,
    );
    expect(result).toMatchObject({
      protectedCashCents: 5_000,
      investableCashCents: 0,
    });
  });
  it("requires a missing amount", () => {
    expect(
      evaluateSafety({ expenses: [], riskPreference: "unknown" }, now),
    ).toMatchObject({ decision: "clarify", reasonCodes: ["MISSING_AMOUNT"] });
  });
  it("rejects negative values", () => {
    expect(
      evaluateSafety(
        { availableCashCents: -1, expenses: [], riskPreference: "unknown" },
        now,
      ),
    ).toMatchObject({
      decision: "reject",
      reasonCodes: ["INVALID_NEGATIVE_AMOUNT"],
      investableCashCents: 0,
    });
  });
  it("pauses for a major obligation increase", () => {
    const result = evaluateSafety(
      {
        availableCashCents: 40_000,
        expenses: [],
        riskPreference: "unknown",
        obligationIncreaseCents: 15_000,
      },
      now,
    );
    expect(result).toMatchObject({
      decision: "pause",
      pauseContributions: true,
    });
    expect(result.reasonCodes).toContain("MAJOR_OBLIGATION_INCREASE");
  });
  it("is identical for identical inputs", () => {
    const input = {
      availableCashCents: 10_000,
      expenses: [expense(6_000, 30)],
      riskPreference: "low" as const,
    };
    expect(JSON.stringify(evaluateSafety(input, now))).toBe(
      JSON.stringify(evaluateSafety(structuredClone(input), now)),
    );
  });
});
