import { randomUUID } from "node:crypto";
import type { BrokeragePosition } from "../domain/types.js";
import {
  BrokerageError,
  type BrokerageAccount,
  type BrokerageAccountSnapshot,
  type BrokerageActivity,
  type BrokerageOrder,
  type BrokerageService,
  type BrokerageTransfer,
} from "./brokerage.js";

export class FakeBrokerageAdapter implements BrokerageService {
  readonly provider = "fake" as const;
  readonly calls: string[] = [];
  private account?: BrokerageAccount;
  private cashCents = 0;
  private readonly transfers = new Map<string, BrokerageTransfer>();
  private readonly transferKeys = new Map<string, string>();
  private readonly orders = new Map<string, BrokerageOrder>();
  private readonly orderKeys = new Map<string, string>();

  constructor(environment = process.env.NODE_ENV) {
    if (environment === "production")
      throw new BrokerageError(
        "FAKE_BROKERAGE_FORBIDDEN",
        "The fake brokerage adapter cannot run in production.",
      );
  }

  async createOrRetrieveAccount(input: {
    accountId?: string;
  }): Promise<BrokerageAccount> {
    this.calls.push("createOrRetrieveAccount");
    this.account ??= {
      provider: "fake",
      accountId: input.accountId ?? "fake-sandbox-account",
      accountNumber: "SIMULATED",
      status: "ACTIVE",
      buyingPowerCents: this.cashCents,
      updatedAt: new Date().toISOString(),
    };
    return structuredClone(this.account);
  }

  async getAccount(accountId: string): Promise<BrokerageAccount> {
    this.calls.push("getAccount");
    if (!this.account || this.account.accountId !== accountId)
      throw new BrokerageError(
        "ACCOUNT_NOT_FOUND",
        "Sandbox account not found.",
      );
    return {
      ...structuredClone(this.account),
      buyingPowerCents: this.cashCents,
    };
  }

  async getAccountSnapshot(): Promise<BrokerageAccountSnapshot> {
    this.calls.push("getAccountSnapshot");
    const invested = [...this.orders.values()].reduce(
      (sum, order) =>
        sum + (order.status === "filled" ? order.notionalCents : 0),
      0,
    );
    return {
      portfolioValueCents: this.cashCents + invested,
      cashCents: this.cashCents,
      buyingPowerCents: this.cashCents,
    };
  }

  async fundSandbox(input: {
    amountCents: number;
    idempotencyKey: string;
  }): Promise<BrokerageTransfer> {
    this.calls.push("fundSandbox");
    const existing = this.transferKeys.get(input.idempotencyKey);
    if (existing) return structuredClone(this.transfers.get(existing)!);
    const transfer: BrokerageTransfer = {
      id: `fake-transfer-${randomUUID()}`,
      status: "COMPLETE",
      amountCents: input.amountCents,
      direction: "INCOMING",
    };
    this.cashCents += input.amountCents;
    this.transfers.set(transfer.id, transfer);
    this.transferKeys.set(input.idempotencyKey, transfer.id);
    return structuredClone(transfer);
  }

  async getTransfer(
    _accountId: string,
    transferId: string,
  ): Promise<BrokerageTransfer> {
    this.calls.push("getTransfer");
    const transfer = this.transfers.get(transferId);
    if (!transfer)
      throw new BrokerageError(
        "TRANSFER_NOT_FOUND",
        "Sandbox transfer not found.",
      );
    return structuredClone(transfer);
  }

  async submitOrder(input: {
    symbol: string;
    notionalCents: number;
    side: "buy" | "sell";
    clientOrderId: string;
  }): Promise<BrokerageOrder> {
    this.calls.push("submitOrder");
    const existing = this.orderKeys.get(input.clientOrderId);
    if (existing) return structuredClone(this.orders.get(existing)!);
    if (input.side === "buy" && input.notionalCents > this.cashCents)
      throw new BrokerageError(
        "INSUFFICIENT_BUYING_POWER",
        "Insufficient sandbox buying power.",
      );
    const order: BrokerageOrder = {
      id: `fake-order-${randomUUID()}`,
      clientOrderId: input.clientOrderId,
      symbol: input.symbol,
      side: input.side,
      notionalCents: input.notionalCents,
      status: "filled",
    };
    this.cashCents +=
      input.side === "buy" ? -input.notionalCents : input.notionalCents;
    this.orders.set(order.id, order);
    this.orderKeys.set(order.clientOrderId, order.id);
    return structuredClone(order);
  }

  async getOrder(_accountId: string, orderId: string): Promise<BrokerageOrder> {
    this.calls.push("getOrder");
    const order = this.orders.get(orderId);
    if (!order)
      throw new BrokerageError("ORDER_NOT_FOUND", "Sandbox order not found.");
    return structuredClone(order);
  }

  async cancelOrder(_accountId: string, orderId: string): Promise<void> {
    this.calls.push("cancelOrder");
    const order = this.orders.get(orderId);
    if (!order || order.status === "filled")
      throw new BrokerageError(
        "ORDER_NOT_CANCELABLE",
        "Sandbox order cannot be cancelled.",
      );
    order.status = "canceled";
  }

  async getPositions(): Promise<BrokeragePosition[]> {
    this.calls.push("getPositions");
    const bySymbol = new Map<string, number>();
    for (const order of this.orders.values())
      if (order.status === "filled")
        bySymbol.set(
          order.symbol,
          (bySymbol.get(order.symbol) ?? 0) +
            (order.side === "buy" ? order.notionalCents : -order.notionalCents),
        );
    return [...bySymbol]
      .filter(([, cents]) => cents > 0)
      .map(([symbol, cents]) => ({
        symbol,
        quantity: "fractional",
        marketValueCents: cents,
        costBasisCents: cents,
      }));
  }

  async getActivities(): Promise<BrokerageActivity[]> {
    this.calls.push("getActivities");
    return [
      ...[...this.transfers.values()].map((transfer) => ({
        id: transfer.id,
        type: "CSD",
        status: transfer.status,
      })),
      ...[...this.orders.values()].map((order) => ({
        id: order.id,
        type: "FILL",
        status: order.status,
      })),
    ];
  }
}
