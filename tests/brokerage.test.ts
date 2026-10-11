import { describe, expect, it } from "vitest";
import { PennyService } from "../src/application/penny.js";
import type {
  PendingVerification,
  VerificationProvider,
} from "../src/auth/auth0.js";
import {
  AlpacaBrokerageAdapter,
  assertSandboxBaseUrl,
} from "../src/brokerage/alpaca.js";
import { BrokerageError } from "../src/brokerage/brokerage.js";
import { FakeBrokerageAdapter } from "../src/brokerage/fake.js";
import {
  assertOrderCap,
  createBrokerageAllocation,
} from "../src/brokerage/models.js";
import { LocalDemoInterpreter } from "../src/interpreter/interpreter.js";
import type { Interpreter } from "../src/interpreter/interpreter.js";
import { InMemoryRepository } from "../src/repository/memory.js";
import { loadConfig, validateRuntimeConfig } from "../src/config.js";

class Verification implements VerificationProvider {
  starts = 0;
  async start(action: PendingVerification["action"], resourceId: string) {
    this.starts += 1;
    return {
      action,
      resourceId,
      deviceCode: "device-secret",
      userCode: "AUTH-CODE",
      verificationUri: "https://auth.example.test/device",
      expiresAt: Date.now() + 60_000,
      intervalSeconds: 1,
    };
  }
  async waitForVerification() {
    return { subject: "auth0|demo", verifiedAt: new Date().toISOString() };
  }
}

function message(id: string, text: string) {
  return { id, text, photonUserId: "fictional-user", photonSpaceId: "space" };
}

async function proposedService(options: { now?: () => Date } = {}) {
  const repository = new InMemoryRepository();
  const verification = new Verification();
  const brokerage = new FakeBrokerageAdapter("test");
  const service = new PennyService(
    repository,
    new LocalDemoInterpreter(),
    verification,
    "v1",
    options.now ?? (() => new Date("2026-10-11T12:00:00.000Z")),
    brokerage,
    { demoAccountId: "fictional-account", achRelationshipId: "fictional-ach" },
  );
  await service.handle(message("cash", "I have $100"));
  await service.handle(message("expense", "I need $60 for textbooks"));
  const risk = await service.handle(message("risk", "Medium risk"));
  const context = await repository.getUserContext(risk.userId!);
  return {
    repository,
    verification,
    brokerage,
    service,
    risk,
    context: context!,
  };
}

describe("brokerage proposal safety", () => {
  it("handles the complete $100/$60/medium intent in one message", async () => {
    const repository = new InMemoryRepository();
    const service = new PennyService(
      repository,
      new LocalDemoInterpreter(),
      new Verification(),
      "v1",
    );
    const reply = await service.handle(
      message(
        "combined",
        "I received $100, but I need $60 for textbooks. Invest the rest at medium risk.",
      ),
    );
    expect(reply.text).toContain("$60.00 stays protected");
    expect(reply.text).toContain("$24.00 diversified stocks");
    expect(reply.text).toContain("$12.00 bonds");
    expect(reply.text).toContain("$4.00 cash");
  });

  it("creates the exact $24/$12/$4 medium allocation", () => {
    expect(createBrokerageAllocation(4_000, "medium")).toEqual({
      allocation: [
        {
          assetClass: "equities",
          symbol: "VTI",
          weightBps: 6_000,
          amountCents: 2_400,
        },
        {
          assetClass: "bonds",
          symbol: "BND",
          weightBps: 3_000,
          amountCents: 1_200,
        },
        { assetClass: "cash_equivalent", weightBps: 1_000, amountCents: 400 },
      ],
      orders: [
        { symbol: "VTI", notionalCents: 2_400, side: "buy" },
        { symbol: "BND", notionalCents: 1_200, side: "buy" },
      ],
    });
  });

  it("rejects orders above investable, approved, or buying-power caps", () => {
    const orders = [
      { symbol: "VTI" as const, notionalCents: 4_001, side: "buy" as const },
    ];
    expect(() => assertOrderCap(orders, 4_000, 4_000, 10_000)).toThrow(
      "ORDER_AMOUNT_EXCEEDS_APPROVED_CAP",
    );
    expect(() => assertOrderCap(orders, 10_000, 4_000, 10_000)).toThrow();
    expect(() => assertOrderCap(orders, 10_000, 10_000, 4_000)).toThrow();
  });

  it("does not execute from a poll or conversational approval", async () => {
    const { service, brokerage, verification } = await proposedService();
    const reply = await service.handle(message("approve", "approve"));
    expect(reply.text).toContain("Explicit confirmation");
    expect(verification.starts).toBe(0);
    expect(brokerage.calls).not.toContain("submitOrder");
  });

  it("rejects expired confirmation codes", async () => {
    let clock = new Date("2026-10-11T12:00:00.000Z");
    const setup = await proposedService({ now: () => clock });
    clock = new Date("2026-10-11T12:11:00.000Z");
    const reply = await setup.service.handle(
      message(
        "confirm",
        `CONFIRM ${setup.context.pendingProposal!.confirmationCode}`,
      ),
    );
    expect(reply.text).toContain("invalid, expired");
    expect(setup.verification.starts).toBe(0);
    expect(setup.brokerage.calls).not.toContain("submitOrder");
  });

  it("requires a new confirmation after proposal facts change", async () => {
    const setup = await proposedService();
    const oldCode = setup.context.pendingProposal!.confirmationCode;
    await setup.service.handle(
      message("modified", "Actually textbooks are $80"),
    );
    const reply = await setup.service.handle(
      message("old-confirm", `CONFIRM ${oldCode}`),
    );
    expect(reply.text).toContain(
      "invalid, expired, or belongs to a modified plan",
    );
    expect(setup.brokerage.calls).not.toContain("submitOrder");
  });

  it("executes once after exact confirmation and Auth0 verification", async () => {
    const setup = await proposedService();
    const confirmation = await setup.service.handle(
      message(
        "confirm",
        `CONFIRM ${setup.context.pendingProposal!.confirmationCode}`,
      ),
    );
    expect(confirmation.text).toContain("Auth0");
    const result = await setup.service.completeVerification(
      confirmation.userId!,
      confirmation.verification!,
      await setup.verification.waitForVerification(),
    );
    expect(result).toContain("Alpaca sandbox received");
    expect(
      setup.brokerage.calls.filter((call) => call === "submitOrder"),
    ).toHaveLength(2);
    const duplicate = await setup.service.completeVerification(
      confirmation.userId!,
      confirmation.verification!,
      await setup.verification.waitForVerification(),
    );
    expect(duplicate).toContain("already approved");
    expect(
      setup.brokerage.calls.filter((call) => call === "submitOrder"),
    ).toHaveLength(2);
  });

  it("uses brokerage data for weekly updates", async () => {
    const setup = await proposedService();
    const confirmation = await setup.service.handle(
      message(
        "confirm",
        `CONFIRM ${setup.context.pendingProposal!.confirmationCode}`,
      ),
    );
    await setup.service.completeVerification(
      confirmation.userId!,
      confirmation.verification!,
      await setup.verification.waitForVerification(),
    );
    const update = await setup.service.createProactiveUpdate(
      confirmation.userId!,
    );
    expect(update).toContain("Alpaca sandbox portfolio");
    expect(update).toContain("VTI");
    expect(setup.brokerage.calls).toContain("getPositions");
    expect(await setup.service.listUsersDueForWeeklyUpdate()).toEqual([]);
  });

  it("returns a safe message when Alpaca rejects an order", async () => {
    class FailingBrokerage extends FakeBrokerageAdapter {
      override async submitOrder(): Promise<never> {
        throw new BrokerageError(
          "ALPACA_HTTP_503",
          "provider details must not reach the user",
          true,
        );
      }
    }
    const repository = new InMemoryRepository();
    const verification = new Verification();
    const brokerage = new FailingBrokerage("test");
    const service = new PennyService(
      repository,
      new LocalDemoInterpreter(),
      verification,
      "v1",
      undefined,
      brokerage,
      { demoAccountId: "fictional", achRelationshipId: "fictional-ach" },
    );
    await service.handle(message("f-cash", "I have $100"));
    await service.handle(message("f-expense", "I need $60 for textbooks"));
    const risk = await service.handle(message("f-risk", "Medium risk"));
    const context = await repository.getUserContext(risk.userId!);
    const confirmation = await service.handle(
      message(
        "f-confirm",
        `CONFIRM ${context!.pendingProposal!.confirmationCode}`,
      ),
    );
    const result = await service.completeVerification(
      confirmation.userId!,
      confirmation.verification!,
      await verification.waitForVerification(),
    );
    expect(result).toContain("ALPACA_HTTP_503");
    expect(result).not.toContain("provider details");
    expect(result).toContain("protected $60.00 remains untouched");
  });

  it("invalid model output never reaches brokerage", async () => {
    const brokerage = new FakeBrokerageAdapter("test");
    const invalidInterpreter: Interpreter = {
      async interpret() {
        throw new Error("INVALID_GEMINI_OUTPUT");
      },
    };
    const service = new PennyService(
      new InMemoryRepository(),
      invalidInterpreter,
      new Verification(),
      "v1",
      undefined,
      brokerage,
    );
    await expect(
      service.handle(message("invalid", "do something")),
    ).rejects.toThrow("INVALID_GEMINI_OUTPUT");
    expect(brokerage.calls).toEqual([]);
  });

  it("life events reassess without placing an order", async () => {
    const setup = await proposedService();
    const reply = await setup.service.handle(
      message("life", "My car broke down and I need $300"),
    );
    expect(reply.text).toContain("recalculated your capacity");
    expect(setup.brokerage.calls).not.toContain("submitOrder");
  });
});

describe("Alpaca sandbox boundary", () => {
  it("fails closed when production iMessage has no real brokerage provider", () => {
    expect(() =>
      validateRuntimeConfig(
        loadConfig({
          NODE_ENV: "production",
          PENNY_TRANSPORT: "imessage",
          PENNY_BROKERAGE_PROVIDER: "none",
          DATABASE_URL: "postgres://example.test/penny",
        }),
      ),
    ).toThrow("BROKERAGE_NOT_CONFIGURED");
    expect(() => new FakeBrokerageAdapter("production")).toThrow(
      "fake brokerage adapter cannot run in production",
    );
  });

  it("rejects production and lookalike endpoints", () => {
    for (const value of [
      "https://broker-api.alpaca.markets",
      "http://broker-api.sandbox.alpaca.markets",
      "https://broker-api.sandbox.alpaca.markets.evil.test",
    ])
      expect(() => assertSandboxBaseUrl(value)).toThrow(
        "Only the Alpaca sandbox endpoint is allowed",
      );
  });

  it("sends notional orders to the genuine sandbox route without leaking credentials", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const adapter = new AlpacaBrokerageAdapter({
      apiKey: "sandbox-key-secret-value",
      apiSecret: "sandbox-secret-secret-value",
      fetch: (async (input, init) => {
        requests.push({ url: String(input), init });
        return new Response(
          JSON.stringify({
            id: "order-id",
            client_order_id: "proposal-0",
            symbol: "VTI",
            side: "buy",
            notional: "24.00",
            status: "accepted",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }) as typeof fetch,
    });
    const order = await adapter.submitOrder({
      accountId: "account-id",
      symbol: "VTI",
      notionalCents: 2_400,
      side: "buy",
      clientOrderId: "proposal-0",
    });
    expect(order.notionalCents).toBe(2_400);
    expect(requests[0]?.url).toBe(
      "https://broker-api.sandbox.alpaca.markets/v1/trading/accounts/account-id/orders",
    );
    expect(requests[0]?.init?.body).toContain('"notional":"24.00"');
    expect(JSON.stringify(order)).not.toContain("sandbox-key-secret-value");
    const error = new BrokerageError("ALPACA_UNAVAILABLE", "safe");
    expect(JSON.stringify(error)).not.toContain("sandbox-secret-secret-value");
  });
});
