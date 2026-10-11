import { AlpacaBrokerageAdapter } from "../brokerage/alpaca.js";

const command = process.argv[2] ?? "account";
if (command === "reset")
  throw new Error(
    "Alpaca Broker API has no universal account-reset operation. Create a new fictional sandbox account or reset it in Brokerdash; Penny will not synthesize a reset.",
  );
const key = requireEnvironment("ALPACA_BROKER_API_KEY");
const secret = requireEnvironment("ALPACA_BROKER_API_SECRET");
const adapter = new AlpacaBrokerageAdapter({ apiKey: key, apiSecret: secret });
const accountId = process.env.ALPACA_DEMO_ACCOUNT_ID;
const application = parseApplication(
  process.env.ALPACA_DEMO_ACCOUNT_APPLICATION_JSON,
);

if (command === "account") {
  const account = await adapter.createOrRetrieveAccount({
    ...(accountId ? { accountId } : {}),
    ...(application ? { application } : {}),
  });
  console.log(
    JSON.stringify({
      event: "alpaca_sandbox_account_ready",
      accountId: account.accountId,
      status: account.status,
      simulated: true,
    }),
  );
} else if (command === "smoke") {
  if (process.env.PENNY_ALLOW_SANDBOX_WRITE !== "true")
    throw new Error(
      "Set PENNY_ALLOW_SANDBOX_WRITE=true to authorize virtual funding and a $1 sandbox order.",
    );
  const id = requireEnvironment("ALPACA_DEMO_ACCOUNT_ID");
  const relationshipId = requireEnvironment("ALPACA_DEMO_ACH_RELATIONSHIP_ID");
  const suffix = Date.now().toString(36);
  const transfer = await adapter.fundSandbox({
    accountId: id,
    amountCents: 100,
    relationshipId,
    idempotencyKey: `penny-smoke-fund-${suffix}`,
  });
  const order = await adapter.submitOrder({
    accountId: id,
    symbol: "VTI",
    notionalCents: 100,
    side: "buy",
    clientOrderId: `penny-smoke-order-${suffix}`,
  });
  console.log(
    JSON.stringify({
      event: "alpaca_sandbox_smoke_complete",
      simulated: true,
      transferId: transfer.id,
      transferStatus: transfer.status,
      orderId: order.id,
      orderStatus: order.status,
    }),
  );
} else {
  throw new Error("Usage: npm run alpaca:sandbox -- account|smoke|reset");
}

function requireEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function parseApplication(
  value: string | undefined,
): Record<string, unknown> | undefined {
  if (!value) return undefined;
  const parsed: unknown = JSON.parse(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("ALPACA_DEMO_ACCOUNT_APPLICATION_JSON must be an object");
  return parsed as Record<string, unknown>;
}
