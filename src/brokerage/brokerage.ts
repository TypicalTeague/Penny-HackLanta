import type {
  BrokerageAccountRecord,
  BrokeragePosition,
} from "../domain/types.js";

export interface BrokerageAccount extends Omit<
  BrokerageAccountRecord,
  "userId"
> {}

export interface BrokerageTransfer {
  id: string;
  status: string;
  amountCents: number;
  direction: "INCOMING" | "OUTGOING";
}

export interface BrokerageOrder {
  id: string;
  clientOrderId: string;
  symbol: string;
  side: "buy" | "sell";
  notionalCents: number;
  status: string;
}

export interface BrokerageAccountSnapshot {
  portfolioValueCents: number;
  cashCents: number;
  buyingPowerCents: number;
}

export interface BrokerageActivity {
  id: string;
  type: string;
  status?: string;
  occurredAt?: string;
}

export interface BrokerageService {
  readonly provider: "alpaca" | "fake" | "unavailable";
  createOrRetrieveAccount(input: {
    accountId?: string;
    application?: Record<string, unknown>;
  }): Promise<BrokerageAccount>;
  getAccount(accountId: string): Promise<BrokerageAccount>;
  getAccountSnapshot(accountId: string): Promise<BrokerageAccountSnapshot>;
  fundSandbox(input: {
    accountId: string;
    amountCents: number;
    relationshipId: string;
    idempotencyKey: string;
  }): Promise<BrokerageTransfer>;
  getTransfer(
    accountId: string,
    transferId: string,
  ): Promise<BrokerageTransfer>;
  submitOrder(input: {
    accountId: string;
    symbol: string;
    notionalCents: number;
    side: "buy" | "sell";
    clientOrderId: string;
  }): Promise<BrokerageOrder>;
  getOrder(accountId: string, orderId: string): Promise<BrokerageOrder>;
  cancelOrder(accountId: string, orderId: string): Promise<void>;
  getPositions(accountId: string): Promise<BrokeragePosition[]>;
  getActivities(accountId: string): Promise<BrokerageActivity[]>;
}

export class BrokerageError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly retryable = false,
  ) {
    super(message);
    this.name = "BrokerageError";
  }
}

export class UnavailableBrokerageAdapter implements BrokerageService {
  readonly provider = "unavailable" as const;
  private unavailable(): never {
    throw new BrokerageError(
      "BROKERAGE_NOT_CONFIGURED",
      "A sandbox brokerage provider is not configured.",
    );
  }
  async createOrRetrieveAccount(): Promise<never> {
    return this.unavailable();
  }
  async getAccount(): Promise<never> {
    return this.unavailable();
  }
  async getAccountSnapshot(): Promise<never> {
    return this.unavailable();
  }
  async fundSandbox(): Promise<never> {
    return this.unavailable();
  }
  async getTransfer(): Promise<never> {
    return this.unavailable();
  }
  async submitOrder(): Promise<never> {
    return this.unavailable();
  }
  async getOrder(): Promise<never> {
    return this.unavailable();
  }
  async cancelOrder(): Promise<never> {
    return this.unavailable();
  }
  async getPositions(): Promise<never> {
    return this.unavailable();
  }
  async getActivities(): Promise<never> {
    return this.unavailable();
  }
}
