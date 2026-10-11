import { describe, expect, it } from "vitest";
import type {
  PendingVerification,
  VerificationProvider,
} from "../src/auth/auth0.js";
import { PennyService } from "../src/application/penny.js";
import { LocalDemoInterpreter } from "../src/interpreter/interpreter.js";
import { InMemoryRepository } from "../src/repository/memory.js";

class Verification implements VerificationProvider {
  async start(action: PendingVerification["action"], resourceId: string) {
    return {
      action,
      resourceId,
      deviceCode: "device",
      userCode: "CODE",
      verificationUri: "https://example.test/verify",
      expiresAt: Date.now() + 60_000,
      intervalSeconds: 1,
    };
  }
  async waitForVerification() {
    return { subject: "auth0|owner", verifiedAt: "2026-10-11T12:00:00.000Z" };
  }
}

const now = () => new Date("2026-10-11T12:00:00.000Z");
const service = (repository: InMemoryRepository) =>
  new PennyService(
    repository,
    new LocalDemoInterpreter(),
    new Verification(),
    "v1",
    now,
  );
const message = (
  id: string,
  text: string,
  user = "photon-user-a",
  space = "space",
) => ({ id, text, photonUserId: user, photonSpaceId: space });

describe("durable user memory acceptance", () => {
  it("recalls protected cash after a service restart", async () => {
    const repository = new InMemoryRepository();
    await service(repository).handle(message("r1", "I have $100"));
    await service(repository).handle(message("r2", "I need $60 for textbooks"));

    const restarted = service(repository);
    const recalled = await restarted.handle(
      message("r3", "How much are we keeping safe?"),
    );
    expect(recalled.text).toContain("$60.00 safe");
    expect(recalled.text).toContain("$40.00 available");
  });

  it("isolates two users even in the same space", async () => {
    const repository = new InMemoryRepository();
    const penny = service(repository);
    await penny.handle(message("a1", "I have $100", "user-a"));
    await penny.handle(message("a2", "I need $60 for textbooks", "user-a"));
    await penny.handle(message("b1", "I have $250", "user-b"));

    const a = await penny.handle(
      message("a3", "What do you remember about me?", "user-a"),
    );
    const b = await penny.handle(
      message("b2", "What do you remember about me?", "user-b"),
    );
    expect(a.text).toContain("textbooks");
    expect(b.text).not.toContain("textbooks");
    expect(b.text).toContain("$250.00 available");
  });

  it("updates one existing expense instead of duplicating it", async () => {
    const repository = new InMemoryRepository();
    const penny = service(repository);
    await penny.handle(message("u1", "I have $100"));
    const first = await penny.handle(message("u2", "I need $60 for textbooks"));
    await penny.handle(message("u3", "Actually textbooks are $80"));

    const context = await repository.getUserContext(first.userId!);
    expect(context?.mandate.expenses).toHaveLength(1);
    expect(context?.mandate.expenses[0]?.amountCents).toBe(8_000);
    expect(context?.mandate.protectedCashCents).toBe(8_000);
  });

  it("deduplicates a repeated expense message", async () => {
    const repository = new InMemoryRepository();
    const penny = service(repository);
    await penny.handle(message("d1", "I have $100"));
    const first = await penny.handle(message("d2", "I need $60 for textbooks"));
    expect(
      await penny.handle(message("d2", "I need $60 for textbooks")),
    ).toEqual({ duplicate: true });
    expect(
      (await repository.getUserContext(first.userId!))?.mandate.expenses,
    ).toHaveLength(1);
  });

  it("loads persisted state for a proactive update after restart", async () => {
    const repository = new InMemoryRepository();
    const first = service(repository);
    await first.handle(message("p1", "I have $100"));
    await first.handle(message("p2", "I need $60 for textbooks"));
    const risk = await first.handle(message("p3", "Medium risk"));
    const pending = await repository.getUserContext(risk.userId!);
    const approval = await first.handle(
      message("p4", `CONFIRM ${pending!.pendingProposal!.confirmationCode}`),
    );
    await first.completeVerification(approval.userId!, approval.verification!, {
      subject: "auth0|owner",
      verifiedAt: now().toISOString(),
    });

    const update = await service(repository).createProactiveUpdate(
      approval.userId!,
    );
    expect(update).toContain("$60.00 textbooks reserve");
    expect(update).toContain("paper portfolio");
  });

  it("deletes financial memory on Forget me", async () => {
    const repository = new InMemoryRepository();
    const penny = service(repository);
    await penny.handle(message("f1", "I have $100"));
    await penny.handle(message("f2", "I need $60 for textbooks"));
    const deleted = await penny.handle(message("f3", "Forget me"));
    expect(deleted.text).toContain("deleted your Penny profile");

    const recall = await service(repository).handle(
      message("f4", "What do you remember about me?"),
    );
    expect(recall.text).toContain("don’t have any stored financial details");
  });
});
