import { z } from "zod";

export const intentValues = [
  "introduce_cash",
  "add_expense",
  "increase_obligation",
  "report_life_event",
  "report_bonus",
  "report_raise",
  "select_risk",
  "adjust_plan",
  "explore_withdrawal",
  "increase_contribution",
  "continue_plan",
  "approve_plan",
  "confirm_proposal",
  "reject_plan",
  "pause",
  "resume",
  "reset",
  "ask_security",
  "claim_deposit",
  "ask_order_status",
  "recall_memory",
  "ask_plan",
  "forget_expense",
  "forget_me",
  "other",
] as const;

export const InterpretationSchema = z.object({
  intent: z.enum(intentValues),
  availableAmountCents: z.number().int().nonnegative().nullable(),
  expenseLabel: z.string().max(80).nullable(),
  expenseAmountCents: z.number().int().nonnegative().nullable(),
  expenseDueDate: z.string().date().nullable(),
  expenseHorizonDays: z.number().int().nonnegative().nullable(),
  eventType: z
    .enum(["unexpected_expense", "rent_increase", "bonus", "raise", "other"])
    .nullable()
    .default(null),
  essential: z.boolean().nullable(),
  riskPreference: z.enum(["unknown", "low", "medium", "high"]).nullable(),
  userQuestion: z.string().max(300).nullable(),
  confidence: z.number().min(0).max(1),
  missingInformation: z.array(z.string().max(80)).max(10),
  suggestedClarificationQuestion: z.string().max(240).nullable(),
  confirmationCode: z
    .string()
    .regex(/^[A-Z0-9]{4,12}$/)
    .nullable()
    .default(null),
});

export type Interpretation = z.infer<typeof InterpretationSchema>;

export const interpretationJsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    intent: { type: "string", enum: intentValues },
    availableAmountCents: { type: ["integer", "null"], minimum: 0 },
    expenseLabel: { type: ["string", "null"] },
    expenseAmountCents: { type: ["integer", "null"], minimum: 0 },
    expenseDueDate: { type: ["string", "null"], format: "date" },
    expenseHorizonDays: { type: ["integer", "null"], minimum: 0 },
    eventType: {
      type: ["string", "null"],
      enum: [
        "unexpected_expense",
        "rent_increase",
        "bonus",
        "raise",
        "other",
        null,
      ],
    },
    essential: { type: ["boolean", "null"] },
    riskPreference: {
      type: ["string", "null"],
      enum: ["unknown", "low", "medium", "high", null],
    },
    userQuestion: { type: ["string", "null"] },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    missingInformation: { type: "array", items: { type: "string" } },
    suggestedClarificationQuestion: { type: ["string", "null"] },
    confirmationCode: { type: ["string", "null"], pattern: "^[A-Z0-9]{4,12}$" },
  },
  required: [
    "intent",
    "availableAmountCents",
    "expenseLabel",
    "expenseAmountCents",
    "expenseDueDate",
    "expenseHorizonDays",
    "eventType",
    "essential",
    "riskPreference",
    "userQuestion",
    "confidence",
    "missingInformation",
    "suggestedClarificationQuestion",
    "confirmationCode",
  ],
} as const;
