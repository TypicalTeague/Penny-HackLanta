import { describe, expect, it } from "vitest";
import { AlpacaBrokerageAdapter } from "../src/brokerage/alpaca.js";

const configured = Boolean(
  process.env.ALPACA_BROKER_API_KEY &&
  process.env.ALPACA_BROKER_API_SECRET &&
  process.env.ALPACA_DEMO_ACCOUNT_ID &&
  process.env.ALPACA_DEMO_ACH_RELATIONSHIP_ID,
);

describe.skipIf(!configured)("credentialed Alpaca sandbox", () => {
  it("retrieves, virtually funds, orders $1 of VTI, and retrieves status", async () => {
    const adapter = new AlpacaBrokerageAdapter({
      apiKey: process.env.ALPACA_BROKER_API_KEY!,
      apiSecret: process.env.ALPACA_BROKER_API_SECRET!,
    });
    const accountId = process.env.ALPACA_DEMO_ACCOUNT_ID!;
    const account = await adapter.getAccount(accountId);
    expect(account.accountId).toBe(accountId);
    await adapter.fundSandbox({
      accountId,
      amountCents: 100,
      relationshipId: process.env.ALPACA_DEMO_ACH_RELATIONSHIP_ID!,
      idempotencyKey: `penny-sandbox-test-${Date.now()}`,
    });
    const order = await adapter.submitOrder({
      accountId,
      symbol: "VTI",
      notionalCents: 100,
      side: "buy",
      clientOrderId: `penny-sandbox-${Date.now()}`,
    });
    expect((await adapter.getOrder(accountId, order.id)).id).toBe(order.id);
  }, 30_000);
});
