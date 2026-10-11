import { BrokerageError, type BrokerageService } from "./brokerage.js";
import type {
  BrokerageAccount,
  BrokerageAccountSnapshot,
  BrokerageActivity,
  BrokerageOrder,
  BrokerageTransfer,
} from "./brokerage.js";
import type { BrokeragePosition } from "../domain/types.js";

export const ALPACA_SANDBOX_ORIGIN =
  "https://broker-api.sandbox.alpaca.markets";

export interface AlpacaBrokerageOptions {
  apiKey: string;
  apiSecret: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export class AlpacaBrokerageAdapter implements BrokerageService {
  readonly provider = "alpaca" as const;
  private readonly origin: string;
  private readonly fetcher: typeof fetch;
  private readonly timeoutMs: number;
  private readonly authorization: string;

  constructor(options: AlpacaBrokerageOptions) {
    if (!options.apiKey || !options.apiSecret)
      throw new BrokerageError(
        "ALPACA_CREDENTIALS_MISSING",
        "Alpaca sandbox credentials are required.",
      );
    this.origin = assertSandboxBaseUrl(
      options.baseUrl ?? ALPACA_SANDBOX_ORIGIN,
    );
    this.fetcher = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 12_000;
    this.authorization = `Basic ${Buffer.from(`${options.apiKey}:${options.apiSecret}`).toString("base64")}`;
  }

  async createOrRetrieveAccount(input: {
    accountId?: string;
    application?: Record<string, unknown>;
  }): Promise<BrokerageAccount> {
    if (input.accountId) return this.getAccount(input.accountId);
    if (!input.application)
      throw new BrokerageError(
        "ALPACA_DEMO_ACCOUNT_MISSING",
        "Configure an existing fictional sandbox account or an explicit sandbox application.",
      );
    return accountFrom(
      await this.request("POST", "/v1/accounts", input.application),
    );
  }

  async getAccount(accountId: string): Promise<BrokerageAccount> {
    return accountFrom(
      await this.request(
        "GET",
        `/v1/accounts/${encodeURIComponent(accountId)}`,
      ),
    );
  }

  async getAccountSnapshot(
    accountId: string,
  ): Promise<BrokerageAccountSnapshot> {
    const value = objectFrom(
      await this.request(
        "GET",
        `/v1/trading/accounts/${encodeURIComponent(accountId)}/account`,
      ),
    );
    return {
      portfolioValueCents: dollarsToCents(value.portfolio_value),
      cashCents: dollarsToCents(value.cash),
      buyingPowerCents: dollarsToCents(value.buying_power),
    };
  }

  async fundSandbox(input: {
    accountId: string;
    amountCents: number;
    relationshipId: string;
    idempotencyKey: string;
  }): Promise<BrokerageTransfer> {
    assertPositiveCents(input.amountCents);
    if (!input.relationshipId)
      throw new BrokerageError(
        "ALPACA_ACH_RELATIONSHIP_MISSING",
        "A fictional sandbox ACH relationship is required for virtual funding.",
      );
    const value = await this.request(
      "POST",
      `/v1/accounts/${encodeURIComponent(input.accountId)}/transfers`,
      {
        transfer_type: "ach",
        relationship_id: input.relationshipId,
        amount: centsToDollars(input.amountCents),
        direction: "INCOMING",
      },
      { "Idempotency-Key": input.idempotencyKey },
    );
    return transferFrom(value);
  }

  async getTransfer(
    accountId: string,
    transferId: string,
  ): Promise<BrokerageTransfer> {
    return transferFrom(
      await this.request(
        "GET",
        `/v1/accounts/${encodeURIComponent(accountId)}/transfers/${encodeURIComponent(transferId)}`,
      ),
    );
  }

  async submitOrder(input: {
    accountId: string;
    symbol: string;
    notionalCents: number;
    side: "buy" | "sell";
    clientOrderId: string;
  }): Promise<BrokerageOrder> {
    assertPositiveCents(input.notionalCents);
    if (!new Set(["VTI", "BND"]).has(input.symbol))
      throw new BrokerageError(
        "UNAPPROVED_SECURITY",
        "The requested security is outside Penny's model portfolio.",
      );
    return orderFrom(
      await this.request(
        "POST",
        `/v1/trading/accounts/${encodeURIComponent(input.accountId)}/orders`,
        {
          symbol: input.symbol,
          notional: centsToDollars(input.notionalCents),
          side: input.side,
          type: "market",
          time_in_force: "day",
          client_order_id: input.clientOrderId,
        },
      ),
    );
  }

  async getOrder(accountId: string, orderId: string): Promise<BrokerageOrder> {
    return orderFrom(
      await this.request(
        "GET",
        `/v1/trading/accounts/${encodeURIComponent(accountId)}/orders/${encodeURIComponent(orderId)}`,
      ),
    );
  }

  async cancelOrder(accountId: string, orderId: string): Promise<void> {
    await this.request(
      "DELETE",
      `/v1/trading/accounts/${encodeURIComponent(accountId)}/orders/${encodeURIComponent(orderId)}`,
    );
  }

  async getPositions(accountId: string): Promise<BrokeragePosition[]> {
    const values = arrayFrom(
      await this.request(
        "GET",
        `/v1/trading/accounts/${encodeURIComponent(accountId)}/positions`,
      ),
    );
    return values.map((entry) => {
      const value = objectFrom(entry);
      return {
        symbol: stringFrom(value.symbol, "position symbol"),
        quantity: stringFrom(value.qty, "position quantity"),
        marketValueCents: dollarsToCents(value.market_value),
        costBasisCents: dollarsToCents(value.cost_basis),
      };
    });
  }

  async getActivities(accountId: string): Promise<BrokerageActivity[]> {
    const query = new URLSearchParams({ account_id: accountId });
    return arrayFrom(
      await this.request("GET", `/v1/accounts/activities?${query}`),
    ).map((entry) => {
      const value = objectFrom(entry);
      return {
        id: stringFrom(value.id, "activity id"),
        type: String(value.activity_type ?? value.type ?? "unknown"),
        ...(typeof value.status === "string" ? { status: value.status } : {}),
        ...(typeof value.date === "string" ? { occurredAt: value.date } : {}),
      };
    });
  }

  private async request(
    method: string,
    path: string,
    body?: Record<string, unknown>,
    extraHeaders: Record<string, string> = {},
  ): Promise<unknown> {
    assertSandboxBaseUrl(this.origin);
    let response: Response;
    try {
      response = await this.fetcher(new URL(path, this.origin), {
        method,
        headers: {
          accept: "application/json",
          authorization: this.authorization,
          ...(body ? { "content-type": "application/json" } : {}),
          ...extraHeaders,
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new BrokerageError(
        "ALPACA_UNAVAILABLE",
        "Alpaca sandbox could not be reached.",
        true,
      );
    }
    if (response.status === 204) return {};
    const data = await response.json().catch(() => ({}));
    if (!response.ok)
      throw new BrokerageError(
        `ALPACA_HTTP_${response.status}`,
        "Alpaca sandbox rejected the request.",
        response.status === 429 || response.status >= 500,
      );
    return data;
  }
}

export function assertSandboxBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new BrokerageError(
      "ALPACA_PRODUCTION_ENDPOINT_REJECTED",
      "Only the Alpaca sandbox endpoint is allowed.",
    );
  }
  if (url.protocol !== "https:" || url.origin !== ALPACA_SANDBOX_ORIGIN)
    throw new BrokerageError(
      "ALPACA_PRODUCTION_ENDPOINT_REJECTED",
      "Only the Alpaca sandbox endpoint is allowed.",
    );
  return url.origin;
}

function accountFrom(input: unknown): BrokerageAccount {
  const value = objectFrom(input);
  return {
    provider: "alpaca",
    accountId: stringFrom(value.id, "account id"),
    ...(typeof value.account_number === "string"
      ? { accountNumber: value.account_number }
      : {}),
    status: String(value.status ?? "UNKNOWN"),
    buyingPowerCents: dollarsToCents(value.buying_power ?? 0),
    updatedAt: new Date().toISOString(),
  };
}

function transferFrom(input: unknown): BrokerageTransfer {
  const value = objectFrom(input);
  return {
    id: stringFrom(value.id, "transfer id"),
    status: String(value.status ?? "UNKNOWN"),
    amountCents: dollarsToCents(value.amount),
    direction: value.direction === "OUTGOING" ? "OUTGOING" : "INCOMING",
  };
}

function orderFrom(input: unknown): BrokerageOrder {
  const value = objectFrom(input);
  return {
    id: stringFrom(value.id, "order id"),
    clientOrderId: stringFrom(value.client_order_id, "client order id"),
    symbol: stringFrom(value.symbol, "order symbol"),
    side: value.side === "sell" ? "sell" : "buy",
    notionalCents: dollarsToCents(
      value.notional ?? value.filled_avg_price ?? 0,
    ),
    status: String(value.status ?? "UNKNOWN"),
  };
}

function objectFrom(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new BrokerageError(
      "ALPACA_INVALID_RESPONSE",
      "Alpaca sandbox returned an invalid response.",
    );
  return value as Record<string, unknown>;
}

function arrayFrom(value: unknown): unknown[] {
  if (!Array.isArray(value))
    throw new BrokerageError(
      "ALPACA_INVALID_RESPONSE",
      "Alpaca sandbox returned an invalid response.",
    );
  return value;
}

function stringFrom(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0)
    throw new BrokerageError(
      "ALPACA_INVALID_RESPONSE",
      `Alpaca sandbox response omitted ${label}.`,
    );
  return value;
}

function dollarsToCents(value: unknown): number {
  const amount = Number(value ?? 0);
  if (!Number.isFinite(amount) || amount < 0)
    throw new BrokerageError(
      "ALPACA_INVALID_RESPONSE",
      "Alpaca sandbox returned an invalid money amount.",
    );
  return Math.round(amount * 100);
}

function centsToDollars(value: number): string {
  return (value / 100).toFixed(2);
}

function assertPositiveCents(value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new BrokerageError(
      "INVALID_BROKERAGE_AMOUNT",
      "Brokerage amounts must be positive whole cents.",
    );
}
