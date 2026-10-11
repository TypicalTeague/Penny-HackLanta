import { advancePortfolioWeek, createPortfolio } from "./portfolio.js";
import type { Simulation } from "./types.js";

const DEMO_SEED = 2_950;

export function startSimulation(
  userId: string,
  proposalId: string,
  initialCents: number,
  seed = DEMO_SEED,
  riskPreference: "low" | "medium" | "high" = "medium",
): Simulation {
  return createPortfolio(
    userId,
    proposalId,
    initialCents,
    riskPreference,
    seed,
  );
}

export function advanceSimulation(simulation: Simulation): Simulation {
  return advancePortfolioWeek(simulation, 0);
}

export function formatDollars(cents: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(cents / 100);
}
