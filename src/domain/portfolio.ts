import { createHash } from "node:crypto";
import type {
  AssetClass,
  PortfolioPosition,
  RebalancingEvent,
  RiskPreference,
  SimulatedTransaction,
  Simulation,
  WeeklySnapshot,
} from "./types.js";

export type ApprovedRisk = Exclude<RiskPreference, "unknown">;

export const MODEL_PORTFOLIOS: Record<
  ApprovedRisk,
  Readonly<Record<AssetClass, number>>
> = {
  low: { equities: 2_000, bonds: 6_000, cash_equivalent: 2_000 },
  medium: { equities: 6_000, bonds: 3_000, cash_equivalent: 1_000 },
  high: { equities: 8_500, bonds: 1_000, cash_equivalent: 500 },
};

export const DEFAULT_REBALANCE_THRESHOLD_BPS = 500;
const ASSET_CLASSES: AssetClass[] = ["equities", "bonds", "cash_equivalent"];

export function createPortfolio(
  userId: string,
  proposalId: string,
  amountCents: number,
  riskPreference: ApprovedRisk,
  seed = 2_950,
  now = new Date(),
): Simulation {
  assertMoney(amountCents);
  const id = `pf_${proposalId}`;
  const positions = allocateExact(
    amountCents,
    MODEL_PORTFOLIOS[riskPreference],
  );
  const transactions = positions.map((position) =>
    transaction(
      id,
      "initial_allocation",
      position.assetClass,
      position.valueCents,
      position.valueCents,
      0,
      now,
    ),
  );
  return {
    id,
    userId,
    proposalId,
    seed: seed >>> 0,
    initialCents: amountCents,
    currentCents: amountCents,
    tick: 0,
    status: "active",
    riskPreference,
    positions,
    transactions,
    rebalancingEvents: [],
    weeklySnapshots: [],
  };
}

export function allocateExact(
  totalCents: number,
  weights: Readonly<Record<AssetClass, number>>,
): PortfolioPosition[] {
  assertMoney(totalCents);
  const weightTotal = ASSET_CLASSES.reduce((sum, key) => sum + weights[key], 0);
  if (weightTotal !== 10_000)
    throw new Error("Portfolio weights must total 10000 bps");
  let assigned = 0;
  return ASSET_CLASSES.map((assetClass, index) => {
    const valueCents =
      index === ASSET_CLASSES.length - 1
        ? totalCents - assigned
        : Math.floor((totalCents * weights[assetClass]) / 10_000);
    assigned += valueCents;
    return { assetClass, targetWeightBps: weights[assetClass], valueCents };
  });
}

export function maxAllocationDriftBps(positions: PortfolioPosition[]): number {
  const total = valueOf(positions);
  if (total === 0) return 0;
  return Math.max(
    ...positions.map((position) =>
      Math.abs(
        Math.round((position.valueCents * 10_000) / total) -
          position.targetWeightBps,
      ),
    ),
  );
}

export function rebalancePortfolio(
  portfolio: Simulation,
  thresholdBps = DEFAULT_REBALANCE_THRESHOLD_BPS,
  now = new Date(),
): { portfolio: Simulation; rebalanced: boolean } {
  const drift = maxAllocationDriftBps(portfolio.positions);
  if (drift <= thresholdBps)
    return { portfolio: structuredClone(portfolio), rebalanced: false };
  const weights = Object.fromEntries(
    portfolio.positions.map((p) => [p.assetClass, p.targetWeightBps]),
  ) as Record<AssetClass, number>;
  const target = allocateExact(valueOf(portfolio.positions), weights);
  const transactions: SimulatedTransaction[] = [];
  for (const next of target) {
    const current = portfolio.positions.find(
      (p) => p.assetClass === next.assetClass,
    )!;
    const delta = next.valueCents - current.valueCents;
    if (delta !== 0)
      transactions.push(
        transaction(
          portfolio.id,
          "rebalance",
          next.assetClass,
          delta,
          next.valueCents,
          portfolio.tick,
          now,
        ),
      );
  }
  const event: RebalancingEvent = {
    id: stableId(portfolio.id, "rebalance", portfolio.tick),
    portfolioId: portfolio.id,
    week: portfolio.tick,
    maxDriftBps: drift,
    transactionIds: transactions.map((item) => item.id),
    createdAt: now.toISOString(),
  };
  return {
    rebalanced: true,
    portfolio: {
      ...portfolio,
      positions: target,
      currentCents: valueOf(target),
      transactions: [...portfolio.transactions, ...transactions],
      rebalancingEvents: [...portfolio.rebalancingEvents, event],
    },
  };
}

export function advancePortfolioWeek(
  portfolio: Simulation,
  protectedCashCents: number,
  thresholdBps = DEFAULT_REBALANCE_THRESHOLD_BPS,
  now?: Date,
): Simulation {
  if (portfolio.status !== "active") return structuredClone(portfolio);
  const eventTime =
    now ??
    new Date(
      new Date(portfolio.transactions[0]?.createdAt ?? 0).getTime() +
        (portfolio.tick + 1) * 7 * 86_400_000,
    );
  const previousValue = portfolio.currentCents;
  const week = portfolio.tick + 1;
  const moved = portfolio.positions.map((position) => {
    const bps = seededReturnBps(portfolio.seed, week, position.assetClass);
    return {
      ...position,
      valueCents: Math.max(
        0,
        Math.round((position.valueCents * (10_000 + bps)) / 10_000),
      ),
    };
  });
  const marketTransactions = moved.map((position) => {
    const before = portfolio.positions.find(
      (p) => p.assetClass === position.assetClass,
    )!.valueCents;
    return transaction(
      portfolio.id,
      "market_move",
      position.assetClass,
      position.valueCents - before,
      position.valueCents,
      week,
      eventTime,
    );
  });
  const afterMove: Simulation = {
    ...portfolio,
    positions: moved,
    currentCents: valueOf(moved),
    tick: week,
    transactions: [...portfolio.transactions, ...marketTransactions],
  };
  const result = rebalancePortfolio(afterMove, thresholdBps, eventTime);
  const snapshot: WeeklySnapshot = {
    id: stableId(portfolio.id, "snapshot", week),
    portfolioId: portfolio.id,
    week,
    valueCents: result.portfolio.currentCents,
    changeCents: result.portfolio.currentCents - previousValue,
    protectedCashCents,
    rebalanced: result.rebalanced,
    actionRequired: false,
    createdAt: eventTime.toISOString(),
  };
  return {
    ...result.portfolio,
    weeklySnapshots: [...result.portfolio.weeklySnapshots, snapshot],
  };
}

export function withdrawFromPortfolio(
  portfolio: Simulation,
  amountCents: number,
  now = new Date(),
): Simulation {
  assertMoney(amountCents);
  if (amountCents > portfolio.currentCents)
    throw new Error("Withdrawal exceeds simulated portfolio value");
  const remaining = portfolio.currentCents - amountCents;
  const weights = Object.fromEntries(
    portfolio.positions.map((p) => [p.assetClass, p.targetWeightBps]),
  ) as Record<AssetClass, number>;
  const positions = allocateExact(remaining, weights);
  const transactions = positions.flatMap((next) => {
    const before = portfolio.positions.find(
      (p) => p.assetClass === next.assetClass,
    )!.valueCents;
    return before === next.valueCents
      ? []
      : [
          transaction(
            portfolio.id,
            "withdrawal",
            next.assetClass,
            next.valueCents - before,
            next.valueCents,
            portfolio.tick,
            now,
          ),
        ];
  });
  return {
    ...portfolio,
    positions,
    currentCents: remaining,
    transactions: [...portfolio.transactions, ...transactions],
  };
}

export function seededReturnBps(
  seed: number,
  week: number,
  assetClass: AssetClass,
): number {
  // Stable, intentionally modest hackathon returns; no market API dependency.
  if (seed === 2_950 && week === 1) return 295;
  const salt =
    assetClass === "equities"
      ? 0x9e3779b9
      : assetClass === "bonds"
        ? 0x85ebca6b
        : 0xc2b2ae35;
  let x = (seed ^ salt ^ Math.imul(week, 0x27d4eb2d)) >>> 0;
  x ^= x << 13;
  x ^= x >>> 17;
  x ^= x << 5;
  const ranges: Record<AssetClass, [number, number]> = {
    equities: [-180, 240],
    bonds: [-45, 75],
    cash_equivalent: [1, 8],
  };
  const [min, max] = ranges[assetClass];
  return min + ((x >>> 0) % (max - min + 1));
}

export function valueOf(positions: PortfolioPosition[]): number {
  return positions.reduce((sum, position) => sum + position.valueCents, 0);
}

function transaction(
  portfolioId: string,
  type: SimulatedTransaction["type"],
  assetClass: AssetClass,
  amountCents: number,
  balanceAfterCents: number,
  week: number,
  now: Date,
): SimulatedTransaction {
  return {
    id: stableId(
      portfolioId,
      type,
      week,
      assetClass,
      amountCents,
      balanceAfterCents,
    ),
    portfolioId,
    type,
    assetClass,
    amountCents,
    balanceAfterCents,
    week,
    createdAt: now.toISOString(),
  };
}

function stableId(...parts: Array<string | number>): string {
  return `txn_${createHash("sha256").update(parts.join(":")).digest("hex").slice(0, 20)}`;
}

function assertMoney(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error("Invalid simulated amount");
}
