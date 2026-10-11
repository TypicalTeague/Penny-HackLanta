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
  status:
    | "pending"
    | "approved"
    | "rejected"
    | "INTENT_RECEIVED"
    | "PROPOSAL_CREATED"
    | "AWAITING_CONFIRMATION"
    | "VERIFIED"
    | "SUBMITTING"
    | "EXECUTED"
    | "PARTIALLY_FILLED"
    | "REJECTED"
    | "CANCELLED";
  confirmationCode?: string;
  expiresAt?: string;
  confirmedAt?: string;
  allocation?: BrokerageAllocation[];
  expectedOrders?: ExpectedBrokerageOrder[];
  explanation?: string;
  idempotencyKey: string;
  createdAt: string;
}

export interface BrokerageAllocation {
  assetClass: AssetClass;
  symbol?: "VTI" | "BND";
  weightBps: number;
  amountCents: number;
}

export interface ExpectedBrokerageOrder {
  symbol: "VTI" | "BND";
  notionalCents: number;
  side: "buy" | "sell";
}

export interface BrokerageAccountRecord {
  userId: string;
  provider: "alpaca" | "fake";
  accountId: string;
  accountNumber?: string;
  status: string;
  buyingPowerCents: number;
  updatedAt: string;
}

export interface BrokerageTransferRecord {
  id: string;
  userId: string;
  proposalId: string;
  providerTransferId: string;
  direction: "INCOMING" | "OUTGOING";
  amountCents: number;
  status: string;
  idempotencyKey: string;
  createdAt: string;
  updatedAt: string;
}

export interface BrokerageOrderRecord {
  id: string;
  userId: string;
  proposalId: string;
  providerOrderId: string;
  clientOrderId: string;
  symbol: string;
  side: "buy" | "sell";
  notionalCents: number;
  status: string;
  createdAt: string;
  updatedAt: string;
}

export interface BrokeragePosition {
  symbol: string;
  quantity: string;
  marketValueCents: number;
  costBasisCents: number;
}

export interface BrokerageSnapshot {
  id: string;
  userId: string;
  accountId: string;
  portfolioValueCents: number;
  cashCents: number;
  buyingPowerCents: number;
  positions: BrokeragePosition[];
  simulated: true;
  capturedAt: string;
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
