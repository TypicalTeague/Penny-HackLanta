import { expect, it } from "vitest";
import {
  advanceSimulation,
  startSimulation,
} from "../src/domain/simulation.js";

it("reproduces the judge demo movement and labels state as data", () => {
  const start = startSimulation("u1", "p1", 4_000);
  expect(advanceSimulation(start).currentCents).toBe(4_118);
  expect(advanceSimulation(start)).toEqual(advanceSimulation(start));
});

it("never advances a paused simulation", () => {
  const paused = {
    ...startSimulation("u1", "p1", 4_000),
    status: "paused" as const,
  };
  expect(advanceSimulation(paused)).toEqual(paused);
});
