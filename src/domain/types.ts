export type RiskPreference = "unknown" | "low" | "medium" | "high";

export type AssetClass = "equities" | "bonds" | "cash_equivalent";

export interface IncomeChange {
  id: string;
  type: "raise" | "bonus";
  label: string;
  amountCents: number;
  recurring: boolean;
  effectiveDate?: string;
  createdAt: string;
}

export interface Expense {
  id: string;
  label: string;
  amountCents: number;
  essential: boolean;
  active?: boolean;
  dueAt?: string;
  horizonDays?: number;
}

export interface Goal {
  id: string;
  label: string;
  targetAmountCents?: number;
  targetDate?: string;
  priority: number;
  active: boolean;
}

export interface Mandate {
  userId: string;
  availableCashCents?: number;
  expenses: Expense[];
  goals: Goal[];
  incomeChanges: IncomeChange[];
  timeHorizonDays?: number;
  riskPreference: RiskPreference;
  protectedCashCents: number;
  recurringContributionCents: number;
  contributionsPaused: boolean;
  approvedProposalId?: string;
  pendingProposalId?: string;
  verifiedSubject?: string;
  verifiedAt?: string;
  consentVersion: string;
  version: number;
}

export interface ConversationMemory {
  userId: string;
  conciseSummary: string;
  unresolvedQuestions: string[];
  lastIntent?: string;
  updatedAt: string;
}

export type ReasonCode =
  | "MISSING_AMOUNT"
  | "INVALID_NEGATIVE_AMOUNT"
  | "PROTECT_NEAR_TERM_ESSENTIAL"
  | "NO_CAPACITY_AFTER_PROTECTION"
  | "MAJOR_OBLIGATION_INCREASE"
  | "BONUS_AVAILABLE"
  | "RECURRING_INCOME_INCREASED"
  | "EMERGENCY_EXPENSE_REPORTED"
  | "WITHDRAWAL_MAY_BE_NEEDED"
  | "RISK_CANNOT_OVERRIDE_CAPACITY"
  | "WITHIN_SAFE_CAPACITY";

export interface SafetyResult {
  decision: "clarify" | "propose" | "pause" | "reject";
  availableCashCents: number;
  protectedCashCents: number;
  investableCashCents: number;
  pauseContributions: boolean;
  reasonCodes: ReasonCode[];
  explanation: {
    protectedExpenseLabels: string[];
    summary: string;
  };
}

export interface Proposal {
  id: string;
  userId: string;
  mandateVersion: number;
  protectedCashCents: number;
  investableCashCents: number;
  reasonCodes: ReasonCode[];
  type?: "activate" | "pause" | "contribution" | "withdrawal" | "risk_change";
  requestedAmountCents?: number;
  riskPreference?: RiskPreference;
  status: "pending" | "approved" | "rejected";
  idempotencyKey: string;
  createdAt: string;
}

export interface PortfolioPosition {
  assetClass: AssetClass;
  targetWeightBps: number;
  valueCents: number;
}

export interface SimulatedTransaction {
  id: string;
  portfolioId: string;
  type:
    | "initial_allocation"
    | "market_move"
    | "rebalance"
    | "contribution"
    | "withdrawal";
  assetClass: AssetClass;
  amountCents: number;
  balanceAfterCents: number;
  week: number;
  createdAt: string;
}

export interface RebalancingEvent {
  id: string;
  portfolioId: string;
  week: number;
  maxDriftBps: number;
  transactionIds: string[];
  createdAt: string;
}

export interface WeeklySnapshot {
  id: string;
  portfolioId: string;
  week: number;
  valueCents: number;
  changeCents: number;
  protectedCashCents: number;
  rebalanced: boolean;
  actionRequired: boolean;
  createdAt: string;
}

export interface Simulation {
  id: string;
  userId: string;
  proposalId: string;
  seed: number;
  initialCents: number;
  currentCents: number;
  tick: number;
  status: "active" | "paused" | "reset";
  riskPreference: Exclude<RiskPreference, "unknown">;
  positions: PortfolioPosition[];
  transactions: SimulatedTransaction[];
  rebalancingEvents: RebalancingEvent[];
  weeklySnapshots: WeeklySnapshot[];
}

export interface AuditEvent {
  id: string;
  userId: string;
  type: string;
  originalMessageId?: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface UserRecord {
  id: string;
  photonUserId: string;
  photonSpaceId: string;
  auth0Subject?: string;
  verificationStatus: "unverified" | "verified" | "deleted";
  consentVersion: string;
  mandate: Mandate;
}

export interface UserContext {
  user: UserRecord;
  mandate: Mandate;
  memory?: ConversationMemory;
  pendingProposal?: Proposal;
  simulation?: Simulation;
}
