import { describe, expect, it } from "vitest";
import {
  Auth0DeviceAuthorization,
  type PendingVerification,
} from "../src/auth/auth0.js";
import { PennyService } from "../src/application/penny.js";
import { loadConfig, validateRuntimeConfig } from "../src/config.js";
import { createPortfolio } from "../src/domain/portfolio.js";
import {
  GeminiInterpreter,
  type GeminiInterpreterOptions,
  LocalDemoInterpreter,
} from "../src/interpreter/interpreter.js";
import { InMemoryRepository } from "../src/repository/memory.js";
import { PostgresRepository } from "../src/repository/postgres.js";
import { finishVerification } from "../src/transport/spectrum.js";

const structuredInterpretation = JSON.stringify({
  intent: "introduce_cash",
  availableAmountCents: 10_000,
  expenseLabel: null,
  expenseAmountCents: null,
  expenseDueDate: null,
  expenseHorizonDays: null,
  eventType: null,
  essential: null,
  riskPreference: "unknown",
  userQuestion: null,
  confidence: 1,
  missingInformation: [],
  suggestedClarificationQuestion: null,
});

function fakeGemini(
  generateContent: (request: { model: string }) => Promise<{ text?: string }>,
): GeminiInterpreterOptions["client"] {
  return {
    models: { generateContent },
  } as unknown as GeminiInterpreterOptions["client"];
}

describe("provider and deployment reliability", () => {
  it("uses the configured Gemini model first and retries a 429", async () => {
    const calls: string[] = [];
    let attempt = 0;
    const interpreter = new GeminiInterpreter("test", {
      model: "configured-model",
      fallbackModels: ["fallback-model"],
      retryBaseMs: 1,
      sleep: async () => undefined,
      client: fakeGemini(async ({ model }) => {
        calls.push(model);
        attempt += 1;
        if (attempt === 1) throw { status: 429 };
        return { text: structuredInterpretation };
      }),
    });

    expect(
      (await interpreter.interpret("I have $100", new Date())).intent,
    ).toBe("introduce_cash");
    expect(calls).toEqual(["configured-model", "configured-model"]);
  });

  it("does not retry a non-transient Gemini error before fallback", async () => {
    const calls: string[] = [];
    const interpreter = new GeminiInterpreter("test", {
      model: "configured-model",
      fallbackModels: ["fallback-model"],
      client: fakeGemini(async ({ model }) => {
        calls.push(model);
        if (model === "configured-model") throw { status: 403 };
        return { text: structuredInterpretation };
      }),
    });
    await interpreter.interpret("I have $100", new Date());
    expect(calls).toEqual(["configured-model", "fallback-model"]);
  });

  it("fails production startup instead of silently using volatile memory", () => {
    const config = loadConfig({
      PENNY_TRANSPORT: "imessage",
      PENNY_INTERPRETER: "gemini",
    });
    expect(() => validateRuntimeConfig(config)).toThrow(/DATABASE_URL/);
    expect(() =>
      validateRuntimeConfig(
        loadConfig({
          PENNY_TRANSPORT: "terminal",
          PENNY_INTERPRETER: "local",
        }),
      ),
    ).not.toThrow();
  });

  it("respects Auth0 pending and slow-down polling responses", async () => {
    const delays: number[] = [];
    const responses = [
      new Response(JSON.stringify({ error: "authorization_pending" }), {
        status: 403,
      }),
      new Response(JSON.stringify({ error: "slow_down" }), { status: 403 }),
      new Response(JSON.stringify({ access_token: "verified-token" }), {
        status: 200,
      }),
    ];
    const auth = new Auth0DeviceAuthorization(
      "tenant.example",
      "client",
      "audience",
      {
        fetch: async () => responses.shift()!,
        delay: async (milliseconds) => {
          delays.push(milliseconds);
        },
        verifyToken: async (token) => {
          expect(token).toBe("verified-token");
          return "auth0|owner";
        },
      },
    );
    const identity = await auth.waitForVerification({
      action: "pause",
      resourceId: "user",
      deviceCode: "device",
      userCode: "code",
      verificationUri: "https://tenant.example/activate",
      expiresAt: Date.now() + 60_000,
      intervalSeconds: 1,
    });
    expect(identity.subject).toBe("auth0|owner");
    expect(delays).toEqual([1_000, 1_000, 6_000]);
  });
});

describe("transaction and persistence reliability", () => {
  it("commits the receipt atomically with the business response", async () => {
    const repository = new InMemoryRepository();
    const verification = {
      async start(): Promise<PendingVerification> {
        throw new Error("not used");
      },
      async waitForVerification() {
        throw new Error("not used");
      },
    };
    const service = new PennyService(
      repository,
      new LocalDemoInterpreter(),
      verification,
      "v1",
    );
    const input = {
      id: "atomic-message",
      photonUserId: "user",
      photonSpaceId: "space",
      text: "I have $100",
    };
    await service.handle(input);
    expect(await service.handle(input)).toEqual({ duplicate: true });
  });

  it("rolls back identity and proposal state when activation persistence fails", async () => {
    class FailingRepository extends InMemoryRepository {
      override async saveSimulation(): Promise<void> {
        throw new Error("simulated database failure");
      }
    }
    const repository = new FailingRepository();
    const verification = {
      async start(action: PendingVerification["action"], resourceId: string) {
        return {
          action,
          resourceId,
          deviceCode: "device",
          userCode: "code",
          verificationUri: "https://example.test",
          expiresAt: Date.now() + 60_000,
          intervalSeconds: 1,
        };
      },
      async waitForVerification() {
        return { subject: "auth0|owner", verifiedAt: new Date().toISOString() };
      },
    };
    const service = new PennyService(
      repository,
      new LocalDemoInterpreter(),
      verification,
      "v1",
    );
    const base = (id: string, text: string) => ({
      id,
      text,
      photonUserId: "user",
      photonSpaceId: "space",
    });
    await service.handle(base("a", "I have $100"));
    await service.handle(base("b", "I need $60 for textbooks"));
    await service.handle(base("c", "Medium risk"));
    const approval = await service.handle(base("d", "approve"));

    await expect(
      service.completeVerification(approval.userId!, approval.verification!, {
        subject: "auth0|owner",
        verifiedAt: new Date().toISOString(),
      }),
    ).rejects.toThrow("simulated database failure");
    const user = await repository.getUser(approval.userId!);
    expect(user?.auth0Subject).toBeUndefined();
    expect(user?.verificationStatus).toBe("unverified");
    expect(
      (await repository.getProposal(user!.mandate.pendingProposalId!))?.status,
    ).toBe("pending");
  });

  it("replaces a prior normalized portfolio before inserting a new id", async () => {
    const queries: string[] = [];
    const query = async (sql: string) => {
      queries.push(sql.replace(/\s+/g, " ").trim());
      return { rows: [], rowCount: 1 };
    };
    const repository = new PostgresRepository(
      { query } as never,
      undefined,
      true,
    );
    await repository.saveSimulation(
      createPortfolio("user", "new-proposal", 4_000, "medium"),
    );
    const replacement = queries.findIndex((sql) =>
      sql.startsWith("DELETE FROM portfolios"),
    );
    const upsert = queries.findIndex((sql) =>
      sql.startsWith("INSERT INTO portfolios"),
    );
    expect(replacement).toBeGreaterThan(-1);
    expect(replacement).toBeLessThan(upsert);
    expect(queries[upsert]).not.toContain("id=EXCLUDED.id");
  });

  it("normalizes legacy mandate fields loaded from PostgreSQL", async () => {
    const repository = new PostgresRepository({
      query: async () => ({
        rowCount: 1,
        rows: [
          {
            id: "user",
            photon_user_id: "photon",
            photon_space_id: "space",
            auth0_subject: null,
            verification_status: "unverified",
            consent_version: "v1",
            mandate: {
              userId: "user",
              expenses: [],
              goals: [],
              riskPreference: "moderate",
              protectedCashCents: 0,
              contributionsPaused: false,
              consentVersion: "v1",
              version: 1,
            },
          },
        ],
      }),
    } as never);
    const user = await repository.getUser("user");
    expect(user?.mandate.riskPreference).toBe("medium");
    expect(user?.mandate.incomeChanges).toEqual([]);
    expect(user?.mandate.recurringContributionCents).toBe(0);
  });
});

describe("delivery truthfulness", () => {
  const challenge: PendingVerification = {
    action: "pause",
    resourceId: "user",
    deviceCode: "device",
    userCode: "code",
    verificationUri: "https://example.test",
    expiresAt: Date.now() + 60_000,
    intervalSeconds: 1,
  };

  it("does not claim verification made no changes after state committed", async () => {
    const sent: string[] = [];
    const service = {
      completeVerification: async () => "Verified and changed",
    } as unknown as PennyService;
    const provider = {
      start: async () => challenge,
      waitForVerification: async () => ({
        subject: "auth0|owner",
        verifiedAt: new Date().toISOString(),
      }),
    };
    const space = {
      send: async (content: string) => {
        sent.push(content);
        throw new Error("delivery unavailable");
      },
    };
    await finishVerification(service, provider, "user", challenge, space);
    expect(sent).toEqual(["Verified and changed"]);
  });

  it("reports no changes only when verified state application fails", async () => {
    const sent: string[] = [];
    const service = {
      completeVerification: async () => {
        throw new Error("database unavailable");
      },
    } as unknown as PennyService;
    const provider = {
      start: async () => challenge,
      waitForVerification: async () => ({
        subject: "auth0|owner",
        verifiedAt: new Date().toISOString(),
      }),
    };
    await finishVerification(service, provider, "user", challenge, {
      send: async (content: string) => {
        sent.push(content);
      },
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("made no changes");
  });
});
