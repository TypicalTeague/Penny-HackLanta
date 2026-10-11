import {
  Auth0DeviceAuthorization,
  type PendingVerification,
  type VerificationProvider,
} from "./auth/auth0.js";
import { createServer } from "node:http";
import { PennyService } from "./application/penny.js";
import { loadConfig, requireValue } from "./config.js";
import {
  GeminiInterpreter,
  LocalDemoInterpreter,
} from "./interpreter/interpreter.js";
import { InMemoryRepository } from "./repository/memory.js";
import { PostgresRepository } from "./repository/postgres.js";
import { runSpectrum } from "./transport/spectrum.js";
import { runTerminal } from "./transport/terminal.js";

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const repository = config.DATABASE_URL
    ? PostgresRepository.connect(config.DATABASE_URL)
    : new InMemoryRepository();
  const interpreter =
    config.PENNY_INTERPRETER === "gemini"
      ? new GeminiInterpreter(
          requireValue(config.GEMINI_API_KEY, "GEMINI_API_KEY"),
          config.GEMINI_MODEL,
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
  const service = new PennyService(
    repository,
    interpreter,
    verification,
    config.CONSENT_VERSION,
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
