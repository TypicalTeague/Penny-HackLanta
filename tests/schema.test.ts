import { describe, expect, it } from "vitest";
import { InterpretationSchema } from "../src/interpreter/schema.js";

const valid = {
  intent: "add_expense",
  availableAmountCents: null,
  expenseLabel: "books",
  expenseAmountCents: 6000,
  expenseDueDate: null,
  expenseHorizonDays: 60,
  eventType: null,
  essential: true,
  riskPreference: "unknown",
  userQuestion: null,
  confidence: 0.98,
  missingInformation: [],
  suggestedClarificationQuestion: null,
};

describe("Gemini output boundary", () => {
  it("accepts the exact structured contract", () =>
    expect(InterpretationSchema.parse(valid)).toEqual(valid));
  it("rejects an unvalidated command and negative money", () =>
    expect(() =>
      InterpretationSchema.parse({
        ...valid,
        command: "INVEST_ALL",
        expenseAmountCents: -1,
      }),
    ).toThrow());
  it("rejects confidence outside its range", () =>
    expect(() =>
      InterpretationSchema.parse({ ...valid, confidence: 2 }),
    ).toThrow());
});
