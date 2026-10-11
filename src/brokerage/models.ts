import { createHash } from "node:crypto";
import { allocateExact, MODEL_PORTFOLIOS } from "../domain/portfolio.js";
import type {
  BrokerageAllocation,
  ExpectedBrokerageOrder,
} from "../domain/types.js";
import type { ApprovedRisk } from "../domain/portfolio.js";

const SYMBOLS = { equities: "VTI", bonds: "BND" } as const;

export function createBrokerageAllocation(
  amountCents: number,
  risk: ApprovedRisk,
): { allocation: BrokerageAllocation[]; orders: ExpectedBrokerageOrder[] } {
  const positions = allocateExact(amountCents, MODEL_PORTFOLIOS[risk]);
  const allocation: BrokerageAllocation[] = positions.map((position) => ({
    assetClass: position.assetClass,
    ...(position.assetClass === "cash_equivalent"
      ? {}
      : { symbol: SYMBOLS[position.assetClass] }),
    weightBps: position.targetWeightBps,
    amountCents: position.valueCents,
  }));
  const orders: ExpectedBrokerageOrder[] = allocation.flatMap((item) =>
    item.symbol && item.amountCents > 0
      ? [{ symbol: item.symbol, notionalCents: item.amountCents, side: "buy" }]
      : [],
  );
  return { allocation, orders };
}

export function confirmationCode(proposalId: string): string {
  return createHash("sha256")
    .update(proposalId)
    .digest("hex")
    .slice(0, 4)
    .toUpperCase();
}

export function assertOrderCap(
  orders: ExpectedBrokerageOrder[],
  investableCents: number,
  approvedCents: number,
  buyingPowerCents: number,
): void {
  const total = orders.reduce((sum, order) => sum + order.notionalCents, 0);
  const cap = Math.min(investableCents, approvedCents, buyingPowerCents);
  if (!Number.isSafeInteger(total) || total < 0 || total > cap)
    throw new Error("ORDER_AMOUNT_EXCEEDS_APPROVED_CAP");
}
