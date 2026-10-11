import {
  Auth0DeviceAuthorization,
  type PendingVerification,
  type VerificationProvider,
} from "./auth/auth0.js";
import { createServer } from "node:http";
import { PennyService } from "./application/penny.js";
import { loadConfig, requireValue, validateRuntimeConfig } from "./config.js";
import {
  GeminiInterpreter,
  LocalDemoInterpreter,
} from "./interpreter/interpreter.js";
import { InMemoryRepository } from "./repository/memory.js";
import { PostgresRepository } from "./repository/postgres.js";
import { runSpectrum } from "./transport/spectrum.js";
import { runTerminal } from "./transport/terminal.js";
import { AlpacaBrokerageAdapter } from "./brokerage/alpaca.js";
import { FakeBrokerageAdapter } from "./brokerage/fake.js";
import { UnavailableBrokerageAdapter } from "./brokerage/brokerage.js";

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  validateRuntimeConfig(config);
  const repository = config.DATABASE_URL
    ? PostgresRepository.connect(config.DATABASE_URL)
    : new InMemoryRepository();
  const interpreter =
    config.PENNY_INTERPRETER === "gemini"
      ? new GeminiInterpreter(
          requireValue(config.GEMINI_API_KEY, "GEMINI_API_KEY"),
          {
            model: config.GEMINI_MODEL,
            fallbackModels: config.GEMINI_FALLBACK_MODELS.split(",")
              .map((value) => value.trim())
              .filter(Boolean),
            timeoutMs: config.GEMINI_TIMEOUT_MS,
            maxAttempts: config.GEMINI_MAX_ATTEMPTS,
          },
        )
      : new LocalDemoInterpreter();
  const verification: VerificationProvider =
    config.AUTH0_DOMAIN && config.AUTH0_CLIENT_ID && config.AUTH0_AUDIENCE
      ? new Auth0DeviceAuthorization(
          config.AUTH0_DOMAIN,
          config.AUTH0_CLIENT_ID,
          config.AUTH0_AUDIENCE,
        )
      : new UnconfiguredVerification();
  const brokerage =
    config.PENNY_BROKERAGE_PROVIDER === "alpaca"
      ? new AlpacaBrokerageAdapter({
          apiKey: requireValue(
            config.ALPACA_BROKER_API_KEY,
            "ALPACA_BROKER_API_KEY",
          ),
          apiSecret: requireValue(
            config.ALPACA_BROKER_API_SECRET,
            "ALPACA_BROKER_API_SECRET",
          ),
          baseUrl: config.ALPACA_BROKER_BASE_URL,
        })
      : config.PENNY_BROKERAGE_PROVIDER === "fake"
        ? new FakeBrokerageAdapter(config.NODE_ENV)
        : new UnavailableBrokerageAdapter();
  const service = new PennyService(
    repository,
    interpreter,
    verification,
    config.CONSENT_VERSION,
    () => new Date(),
    brokerage,
    {
      demoAccountId: config.ALPACA_DEMO_ACCOUNT_ID,
      achRelationshipId: config.ALPACA_DEMO_ACH_RELATIONSHIP_ID,
      accountApplication: parseAccountApplication(
        config.ALPACA_DEMO_ACCOUNT_APPLICATION_JSON,
      ),
    },
  );

  if (process.argv.includes("--smoke")) {
    console.log(
      "Penny startup smoke check passed (terminal diagnostics mode).",
    );
    return;
  }
  if (config.PENNY_TRANSPORT === "terminal") return runTerminal(service);
  if (config.PORT) startHealthServer(config.PORT);
  await runSpectrum(
    service,
    verification,
    requireValue(config.SPECTRUM_PROJECT_ID, "SPECTRUM_PROJECT_ID"),
    requireValue(config.SPECTRUM_PROJECT_SECRET, "SPECTRUM_PROJECT_SECRET"),
  );
}

function parseAccountApplication(
  value: string | undefined,
): Record<string, unknown> | undefined {
  if (!value) return undefined;
  const parsed: unknown = JSON.parse(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("ALPACA_DEMO_ACCOUNT_APPLICATION_JSON must be an object");
  return parsed as Record<string, unknown>;
}

function startHealthServer(port: number): void {
  createServer((request, response) => {
    if (request.url === "/healthz") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({ ok: true, product: "penny-robo-investor" }),
      );
      return;
    }
    response.writeHead(404).end();
  }).listen(port, "0.0.0.0", () => {
    console.log(JSON.stringify({ event: "health_server_ready", port }));
  });
}

class UnconfiguredVerification implements VerificationProvider {
  async start(): Promise<PendingVerification> {
    throw new Error("Auth0 must be configured before consequential actions");
  }
  async waitForVerification(): Promise<never> {
    throw new Error("Auth0 must be configured before consequential actions");
  }
}

main().catch((error: unknown) => {
  console.error(
    JSON.stringify({
      event: "fatal",
      message: error instanceof Error ? error.message : "Unknown error",
    }),
  );
  process.exitCode = 1;
});
