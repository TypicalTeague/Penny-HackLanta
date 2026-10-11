import type { Expense, RiskPreference, SafetyResult } from "./types.js";

export interface SafetyInput {
  availableCashCents?: number;
  expenses: Expense[];
  riskPreference: RiskPreference;
  obligationIncreaseCents?: number;
}

const MAJOR_INCREASE_CENTS = 10_000;
const NEAR_TERM_DAYS = 90;

function isNonNegativeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function daysUntil(iso: string, now: Date): number {
  return Math.ceil((new Date(iso).getTime() - now.getTime()) / 86_400_000);
}

function isNearTerm(expense: Expense, now: Date): boolean {
  const days =
    expense.horizonDays ??
    (expense.dueAt ? daysUntil(expense.dueAt, now) : Infinity);
  return expense.essential && days >= 0 && days <= NEAR_TERM_DAYS;
}

export function evaluateSafety(
  input: SafetyInput,
  now = new Date(),
): SafetyResult {
  if (input.availableCashCents === undefined) {
    return result(
      "clarify",
      0,
      0,
      false,
      ["MISSING_AMOUNT"],
      [],
      "We need an amount before making a plan.",
    );
  }

  const amounts = [
    input.availableCashCents,
    ...input.expenses.map((e) => e.amountCents),
  ];
  if (amounts.some((amount) => !isNonNegativeInteger(amount))) {
    return result(
      "reject",
      Math.max(0, input.availableCashCents),
      0,
      false,
      ["INVALID_NEGATIVE_AMOUNT"],
      [],
      "Amounts must be non-negative whole cents.",
    );
  }

  const protectedExpenses = input.expenses.filter((expense) =>
    isNearTerm(expense, now),
  );
  const requestedProtection = protectedExpenses.reduce(
    (sum, expense) => sum + expense.amountCents,
    0,
  );
  const protectedCashCents = Math.min(
    input.availableCashCents,
    requestedProtection,
  );
  const investableCashCents = Math.max(
    0,
    input.availableCashCents - protectedCashCents,
  );
  const reasonCodes: SafetyResult["reasonCodes"] = [];

  if (protectedCashCents > 0) reasonCodes.push("PROTECT_NEAR_TERM_ESSENTIAL");
  if (investableCashCents === 0)
    reasonCodes.push("NO_CAPACITY_AFTER_PROTECTION");

  const increase = input.obligationIncreaseCents ?? 0;
  const majorIncrease =
    increase >= MAJOR_INCREASE_CENTS ||
    (input.availableCashCents > 0 &&
      increase >= Math.ceil(input.availableCashCents * 0.25));
  if (majorIncrease) reasonCodes.push("MAJOR_OBLIGATION_INCREASE");

  if (input.riskPreference === "high" && protectedCashCents > 0) {
    reasonCodes.push("RISK_CANNOT_OVERRIDE_CAPACITY");
  }
  if (reasonCodes.length === 0) reasonCodes.push("WITHIN_SAFE_CAPACITY");

  return result(
    majorIncrease ? "pause" : "propose",
    input.availableCashCents,
    protectedCashCents,
    majorIncrease,
    reasonCodes,
    protectedExpenses.map((expense) => expense.label),
    investableCashCents === 0
      ? "Near-term essentials use all currently available cash."
      : "Near-term essentials are separate from the simulated amount.",
  );
}

function result(
  decision: SafetyResult["decision"],
  availableCashCents: number,
  protectedCashCents: number,
  pauseContributions: boolean,
  reasonCodes: SafetyResult["reasonCodes"],
  protectedExpenseLabels: string[],
  summary: string,
): SafetyResult {
  return {
    decision,
    availableCashCents,
    protectedCashCents,
    investableCashCents: Math.max(0, availableCashCents - protectedCashCents),
    pauseContributions,
    reasonCodes,
    explanation: { protectedExpenseLabels, summary },
  };
}
