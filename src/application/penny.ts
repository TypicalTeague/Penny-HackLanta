import { createHash, randomUUID } from "node:crypto";
import type {
  PendingVerification,
  VerificationProvider,
  VerifiedIdentity,
} from "../auth/auth0.js";
import { evaluateSafety } from "../domain/safety.js";
import {
  MODEL_PORTFOLIOS,
  advancePortfolioWeek,
  contributeToPortfolio,
  createPortfolio,
  withdrawFromPortfolio,
} from "../domain/portfolio.js";
import {
  advanceSimulation,
  formatDollars,
  startSimulation,
} from "../domain/simulation.js";
import type {
  AuditEvent,
  Expense,
  IncomeChange,
  Mandate,
  Proposal,
  UserContext,
} from "../domain/types.js";
import type { Interpreter } from "../interpreter/interpreter.js";
import type { Interpretation } from "../interpreter/schema.js";
import type { PennyRepository } from "../repository/repository.js";
import {
  BrokerageError,
  UnavailableBrokerageAdapter,
  type BrokerageService,
} from "../brokerage/brokerage.js";
import {
  assertOrderCap,
  confirmationCode,
  createBrokerageAllocation,
} from "../brokerage/models.js";

export interface IncomingMessage {
  id: string;
  photonUserId: string;
  photonSpaceId: string;
  legacySenderKey?: string;
  text: string;
}
export interface PennyReply {
  text?: string;
  parts?: PennyReplyPart[];
  acknowledge?: boolean;
  duplicate?: boolean;
  verification?: PendingVerification;
  userId?: string;
}

export type PennyReplyPart =
  | { type: "text"; text: string }
  | { type: "poll"; title: string; options: string[] }
  | { type: "image"; name: string; mimeType: "image/svg+xml"; data: Buffer };

export class PennyService {
  constructor(
    private readonly repository: PennyRepository,
    private readonly interpreter: Interpreter,
    private readonly verification: VerificationProvider,
    private readonly consentVersion: string,
    private readonly now: () => Date = () => new Date(),
    private readonly brokerage: BrokerageService = new UnavailableBrokerageAdapter(),
    private readonly brokerageConfig: {
      demoAccountId?: string;
      achRelationshipId?: string;
      accountApplication?: Record<string, unknown>;
    } = {},
  ) {}

  async handle(input: IncomingMessage): Promise<PennyReply> {
    if (!(await this.repository.claimMessage(input.id)))
      return { duplicate: true };
    try {
      const user = await this.repository.getOrCreateUser(
        input.photonUserId,
        input.photonSpaceId,
        this.consentVersion,
        input.legacySenderKey,
      );
      await this.repository.attachMessageToUser(input.id, user.id);
      const initialContext = await this.repository.getUserContext(user.id);
      if (!initialContext) throw new Error("Penny user context unavailable");
      const parsed =
        deterministicMemoryIntent(input.text) ??
        (await this.interpreter.interpret(
          input.text,
          this.now(),
          interpreterContext(initialContext),
        ));
      await this.repository.recordMessageIntent(input.id, parsed.intent);
      const reply = await this.repository.transaction(async (repository) => {
        await repository.lockUser(user.id);
        const context = await repository.getUserContext(user.id);
        if (!context) throw new Error("Penny user context unavailable");
        await this.auditWith(
          repository,
          user.id,
          "message_interpreted",
          {
            intent: parsed.intent,
            confidence: parsed.confidence,
            contentDigest: digest(input.text),
          },
          input.id,
        );
        const result = await this.applyInterpretation(
          repository,
          context,
          parsed,
          input.id,
        );
        if (parsed.intent !== "forget_me") {
          const refreshed = await repository.getUserContext(user.id);
          if (refreshed)
            await repository.saveConversationMemory(
              buildMemory(refreshed, parsed),
            );
        }
        // The receipt and domain mutations commit together. Once handle returns,
        // a delivery retry must never replay financial state changes.
        await repository.completeMessage(input.id);
        return result;
      });
      return { acknowledge: true, ...reply, userId: user.id };
    } catch (error) {
      await this.repository.releaseMessage(input.id);
      throw error;
    }
  }

  async acknowledgeMessage(messageId: string): Promise<void> {
    await this.repository.completeMessage(messageId);
  }

  async listUsersDueForWeeklyUpdate(): Promise<
    Array<{ userId: string; photonSpaceId: string }>
  > {
    const users = await this.repository.listUsersWithActivePortfolios();
    const due: Array<{ userId: string; photonSpaceId: string }> = [];
    for (const user of users) {
      const portfolio = await this.repository.getSimulationByUser(user.id);
      if (!portfolio) continue;
      const brokerageSnapshot = await this.repository.getBrokerageSnapshot(
        user.id,
      );
      const last =
        brokerageSnapshot?.capturedAt ??
        portfolio.weeklySnapshots.at(-1)?.createdAt ??
        portfolio.transactions.at(0)?.createdAt;
      if (
        !last ||
        this.now().getTime() - new Date(last).getTime() >= 7 * 86_400_000
      )
        due.push({ userId: user.id, photonSpaceId: user.photonSpaceId });
    }
    return due;
  }

  private async applyInterpretation(
    repository: PennyRepository,
    context: UserContext,
    parsed: Interpretation,
    messageId: string,
  ): Promise<PennyReply> {
    const mandate = context.mandate;
    if (parsed.confidence < 0.75 || parsed.missingInformation.length > 0) {
      return {
        text:
          parsed.suggestedClarificationQuestion ??
          "Could you share a little more detail so I can keep the simulation safe?",
      };
    }
    switch (parsed.intent) {
      case "introduce_cash": {
        if (parsed.availableAmountCents === null)
          return {
            text: "How much would you like to use for this paper-only exercise?",
          };
        const next = {
          ...mandate,
          availableCashCents: parsed.availableAmountCents,
          version: mandate.version + 1,
        };
        await repository.saveMandate(next);
        await this.auditWith(
          repository,
          mandate.userId,
          "mandate_cash_recorded",
          { availableAmountCents: parsed.availableAmountCents },
          messageId,
        );
        return {
          text: "Got it. Might you need any of that money for rent, bills, school, or another expense in the next 90 days?",
        };
      }
      case "add_expense":
        return this.addExpenseAndPropose(
          repository,
          mandate,
          parsed,
          messageId,
        );
      case "increase_obligation":
        return this.requestMandateChange(
          repository,
          mandate,
          parsed,
          messageId,
        );
      case "report_life_event":
        return this.recordLifeEvent(repository, mandate, parsed, messageId);
      case "report_bonus":
      case "report_raise":
        return this.recordIncomeChange(repository, mandate, parsed, messageId);
      case "select_risk":
        return this.selectRisk(repository, mandate, parsed, messageId);
      case "adjust_plan":
        return {
          text: "Tell me what you want to adjust—your risk level, simulated contribution, or a protected expense.",
        };
      case "explore_withdrawal":
        return this.requestWithdrawal(repository, context, parsed, messageId);
      case "increase_contribution":
        return this.requestContributionIncrease(
          repository,
          context,
          parsed,
          messageId,
        );
      case "continue_plan":
        return {
          text: "Okay—your current paper mandate stays unchanged. Your real-life expense is still saved, and no simulated transaction occurred.",
        };
      case "approve_plan":
        return this.requestApproval(repository, mandate, messageId);
      case "confirm_proposal":
        return this.confirmProposal(
          repository,
          mandate,
          parsed.confirmationCode,
          messageId,
        );
      case "recall_memory":
      case "ask_plan":
        return { text: planSummary(mandate) };
      case "forget_expense": {
        const target = findExpense(mandate.expenses, parsed.expenseLabel);
        if (!target)
          return {
            text: "I couldn’t find that stored expense. Tell me its name and I’ll remove it.",
          };
        const expenses = mandate.expenses.filter(
          (expense) => expense.id !== target.id,
        );
        const safety = evaluateSafety(
          {
            ...(mandate.availableCashCents !== undefined
              ? { availableCashCents: mandate.availableCashCents }
              : {}),
            expenses,
            riskPreference: mandate.riskPreference,
          },
          this.now(),
        );
        await repository.saveMandate({
          ...mandate,
          expenses,
          protectedCashCents: safety.protectedCashCents,
          version: mandate.version + 1,
        });
        await this.auditWith(
          repository,
          mandate.userId,
          "expense_forgotten",
          { expenseId: target.id },
          messageId,
        );
        return {
          text: `Done—I forgot the ${target.label} expense and recalculated your protected amount to ${formatDollars(safety.protectedCashCents)}.`,
        };
      }
      case "forget_me":
        await this.auditWith(
          repository,
          mandate.userId,
          "privacy_deletion_requested",
          {},
          messageId,
        );
        await repository.deleteUserData(mandate.userId);
        return {
          text: "Done—I deleted your Penny profile, financial facts, plans, and conversation memory. Security-only message records retain no financial content.",
        };
      case "ask_security":
        return {
          text: "I can’t pick a stock or promise a fast return. I can only show a clearly labeled, diversified paper simulation after protecting money you may need soon.",
        };
      case "claim_deposit":
        return {
          text: "Just to be clear: Penny can’t receive deposits or hold money. Any amount here is only part of a simulated paper-investing exercise.",
        };
      case "ask_order_status":
        return this.orderStatus(repository, mandate);
      case "pause":
      case "resume":
      case "reset": {
        const challenge = await this.verification.start(
          parsed.intent,
          mandate.userId,
        );
        return { text: verificationCopy(challenge), verification: challenge };
      }
      case "reject_plan": {
        if (!mandate.pendingProposalId)
          return { text: "There isn’t a pending simulated plan to decline." };
        const proposal = await repository.getProposal(
          mandate.pendingProposalId,
        );
        if (proposal)
          await repository.saveProposal({
            ...proposal,
            status: "rejected",
          });
        const { pendingProposalId: _pending, ...withoutPending } = mandate;
        await repository.saveMandate({
          ...withoutPending,
          version: mandate.version + 1,
        });
        return {
          text: "No problem—the simulated plan is canceled. Nothing moved.",
        };
      }
      default:
        return {
          text: "I can help separate near-term essentials from a paper-investing amount. How much do you have available, and might you need any of it within 90 days?",
        };
    }
  }

  private async addExpenseAndPropose(
    repository: PennyRepository,
    mandate: Mandate,
    parsed: Interpretation,
    messageId: string,
  ): Promise<PennyReply> {
    if (parsed.expenseAmountCents === null)
      return { text: "About how much will that expense be?" };
    const availableCashCents =
      mandate.availableCashCents ?? parsed.availableAmountCents ?? undefined;
    if (availableCashCents === undefined)
      return { text: "How much simulated cash are we starting with?" };
    const existing = findExpense(mandate.expenses, parsed.expenseLabel);
    const expense: Expense = {
      id: existing?.id ?? `exp_${randomUUID()}`,
      label: parsed.expenseLabel ?? "upcoming expense",
      amountCents: parsed.expenseAmountCents,
      essential: parsed.essential ?? true,
      active: true,
      ...(parsed.expenseDueDate ? { dueAt: parsed.expenseDueDate } : {}),
      ...(parsed.expenseHorizonDays !== null
        ? { horizonDays: parsed.expenseHorizonDays }
        : {}),
    };
    const expenses = existing
      ? mandate.expenses.map((item) =>
          item.id === existing.id ? expense : item,
        )
      : [...mandate.expenses, expense];
    const safety = evaluateSafety(
      {
        availableCashCents,
        expenses,
        riskPreference: mandate.riskPreference,
      },
      this.now(),
    );
    const selectedRisk =
      parsed.riskPreference && parsed.riskPreference !== "unknown"
        ? parsed.riskPreference
        : mandate.riskPreference;
    const proposal: Proposal = enrichBrokerageProposal(
      {
        id: `prp_${randomUUID()}`,
        userId: mandate.userId,
        mandateVersion: mandate.version + 1,
        protectedCashCents: safety.protectedCashCents,
        investableCashCents: safety.investableCashCents,
        reasonCodes: safety.reasonCodes,
        type: "activate",
        riskPreference: selectedRisk,
        status: "AWAITING_CONFIRMATION",
        idempotencyKey: `proposal:${messageId}`,
        createdAt: this.now().toISOString(),
      },
      selectedRisk === "unknown" ? "medium" : selectedRisk,
      this.now(),
    );
    const stored = await repository.createProposal(proposal);
    await repository.saveMandate({
      ...mandate,
      availableCashCents,
      expenses,
      protectedCashCents: safety.protectedCashCents,
      riskPreference: selectedRisk,
      pendingProposalId: stored.id,
      version: mandate.version + 1,
    });
    await this.auditWith(
      repository,
      mandate.userId,
      "safety_decision",
      { ...safety, proposalId: stored.id },
      messageId,
    );
    if (safety.investableCashCents === 0)
      return {
        text: `Based on what you told me, now may not be the right time to invest—and that is completely okay. All ${formatDollars(safety.protectedCashCents)} stays protected; the simulated amount is $0.00.`,
      };
    if (selectedRisk === "unknown") {
      const text = `${existing ? "I updated" : "I saved"} your ${expense.label} expense. We’ll keep ${formatDollars(safety.protectedCashCents)} separate and protected; ${formatDollars(safety.investableCashCents)} is available for a diversified simulated paper portfolio. Choose the risk level you’re comfortable with—I’ll handle the allocation and ongoing management.`;
      return {
        text,
        parts: [
          { type: "text", text },
          {
            type: "poll",
            title: "Choose your investing style",
            options: ["Low risk", "Medium risk", "High risk"],
          },
        ],
      };
    }
    return this.proposedPlanReply(
      safety.investableCashCents,
      safety.protectedCashCents,
      selectedRisk,
      stored,
    );
  }

  private async selectRisk(
    repository: PennyRepository,
    mandate: Mandate,
    parsed: Interpretation,
    messageId: string,
  ): Promise<PennyReply> {
    const risk = parsed.riskPreference;
    if (!risk || risk === "unknown")
      return {
        text: "Choose Low, Medium, or High risk.",
        parts: [
          {
            type: "poll",
            title: "Choose your investing style",
            options: ["Low risk", "Medium risk", "High risk"],
          },
        ],
      };
    if (mandate.approvedProposalId && risk !== mandate.riskPreference) {
      const challenge = await this.verification.start(
        "change_risk",
        `risk:${mandate.userId}:${risk}:${mandate.version}`,
      );
      return { text: verificationCopy(challenge), verification: challenge };
    }
    const safety = evaluateSafety(
      {
        ...(mandate.availableCashCents !== undefined
          ? { availableCashCents: mandate.availableCashCents }
          : {}),
        expenses: mandate.expenses,
        riskPreference: risk,
      },
      this.now(),
    );
    const next = {
      ...mandate,
      riskPreference: risk,
      version: mandate.version + 1,
    };
    await repository.saveMandate(next);
    let proposal = mandate.pendingProposalId
      ? await repository.getProposal(mandate.pendingProposalId)
      : undefined;
    if (proposal) {
      proposal = enrichBrokerageProposal(
        {
          ...proposal,
          mandateVersion: next.version,
          riskPreference: risk,
          confirmedAt: undefined,
          status: "AWAITING_CONFIRMATION",
        },
        risk,
        this.now(),
      );
      await repository.saveProposal(proposal);
    } else {
      proposal = await repository.createProposal(
        enrichBrokerageProposal(
          {
            id: `prp_${randomUUID()}`,
            userId: mandate.userId,
            mandateVersion: next.version,
            protectedCashCents: safety.protectedCashCents,
            investableCashCents: safety.investableCashCents,
            reasonCodes: safety.reasonCodes,
            type: "activate",
            riskPreference: risk,
            status: "AWAITING_CONFIRMATION",
            idempotencyKey: `proposal:${messageId}`,
            createdAt: this.now().toISOString(),
          },
          risk,
          this.now(),
        ),
      );
      await repository.saveMandate({ ...next, pendingProposalId: proposal.id });
    }
    await this.auditWith(
      repository,
      mandate.userId,
      "risk_selected",
      { riskPreference: risk },
      messageId,
    );
    return this.proposedPlanReply(
      safety.investableCashCents,
      safety.protectedCashCents,
      risk,
      proposal,
    );
  }

  private proposedPlanReply(
    investableCashCents: number,
    protectedCashCents: number,
    risk: "low" | "medium" | "high",
    proposal: Proposal,
  ): PennyReply {
    const portfolio = createPortfolio(
      "preview",
      "preview",
      investableCashCents,
      risk,
      2_950,
      this.now(),
    );
    const allocation = proposal.allocation ?? [];
    const stocks =
      allocation.find((item) => item.assetClass === "equities")?.amountCents ??
      0;
    const bonds =
      allocation.find((item) => item.assetClass === "bonds")?.amountCents ?? 0;
    const cash =
      allocation.find((item) => item.assetClass === "cash_equivalent")
        ?.amountCents ?? 0;
    const text = `Your ${formatDollars(protectedCashCents)} stays protected 💚 I can place the remaining ${formatDollars(investableCashCents)} into your ${titleCase(risk)} plan: ${formatDollars(stocks)} diversified stocks, ${formatDollars(bonds)} bonds, and ${formatDollars(cash)} cash. This is a simulated Alpaca sandbox portfolio for the demo. Reply CONFIRM ${proposal.confirmationCode} to continue; the code expires in 10 minutes.`;
    return {
      text,
      parts: [
        { type: "text", text },
        portfolioCardPart(portfolio, protectedCashCents, false),
        {
          type: "poll",
          title: "Review this simulated mandate",
          options: ["Show confirmation code", "Adjust it", "Not yet"],
        },
      ],
    };
  }

  private async requestApproval(
    repository: PennyRepository,
    mandate: Mandate,
    messageId: string,
  ): Promise<PennyReply> {
    if (mandate.riskPreference === "unknown")
      return {
        text: "Choose Low, Medium, or High risk before approving the plan.",
        parts: [
          {
            type: "poll",
            title: "Choose your investing style",
            options: ["Low risk", "Medium risk", "High risk"],
          },
        ],
      };
    if (!mandate.pendingProposalId) {
      if (mandate.approvedProposalId)
        return {
          text: "That simulated plan is already active—your duplicate approval did not create another one.",
        };
      return { text: "There isn’t a simulated plan waiting for approval yet." };
    }
    const proposal = await repository.getProposal(mandate.pendingProposalId);
    if (!proposal?.confirmationCode)
      return {
        text: "That proposal is incomplete. Please ask Penny to create a new plan.",
      };
    return {
      text: `Explicit confirmation is required. Reply CONFIRM ${proposal.confirmationCode} before ${new Date(proposal.expiresAt!).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}. A poll tap or ordinary “yes” cannot place sandbox orders.`,
    };
  }

  private async confirmProposal(
    repository: PennyRepository,
    mandate: Mandate,
    code: string | null,
    messageId: string,
  ): Promise<PennyReply> {
    if (!mandate.pendingProposalId)
      return { text: "There is no proposal awaiting confirmation." };
    const proposal = await repository.getProposal(mandate.pendingProposalId);
    if (!proposal) return { text: "That proposal is no longer available." };
    if (
      proposal.status === "EXECUTED" ||
      proposal.status === "PARTIALLY_FILLED"
    )
      return {
        text: "That simulated proposal was already executed; no duplicate orders were created.",
      };
    if (
      !code ||
      code !== proposal.confirmationCode ||
      !proposal.expiresAt ||
      new Date(proposal.expiresAt).getTime() <= this.now().getTime() ||
      proposal.mandateVersion !== mandate.version
    ) {
      await this.auditWith(
        repository,
        mandate.userId,
        "confirmation_rejected",
        {
          proposalId: proposal.id,
          reason:
            proposal.mandateVersion !== mandate.version
              ? "MODIFIED"
              : "INVALID_OR_EXPIRED",
        },
        messageId,
      );
      return {
        text: "That confirmation is invalid, expired, or belongs to a modified plan. I made no transfer or order; please request a fresh proposal.",
      };
    }
    const confirmed = {
      ...proposal,
      confirmedAt: this.now().toISOString(),
    };
    await repository.saveProposal(confirmed);
    await this.auditWith(
      repository,
      mandate.userId,
      "proposal_confirmed",
      {
        proposalId: proposal.id,
        approvedAmountCents: proposal.investableCashCents,
      },
      messageId,
    );
    const challenge = await this.verification.start(
      "approve_plan",
      proposal.id,
    );
    await this.auditWith(
      repository,
      mandate.userId,
      "verification_started",
      {
        action: challenge.action,
        resourceId: proposal.id,
      },
      messageId,
    );
    return { text: verificationCopy(challenge), verification: challenge };
  }

  private async requestMandateChange(
    repository: PennyRepository,
    mandate: Mandate,
    parsed: Interpretation,
    messageId: string,
  ): Promise<PennyReply> {
    if (parsed.expenseAmountCents === null)
      return { text: "About how much is that obligation increasing?" };
    const resource = `change:${mandate.userId}:${parsed.expenseAmountCents}:${encodeURIComponent(parsed.expenseLabel ?? "obligation")}`;
    const challenge = await this.verification.start("change_mandate", resource);
    await this.auditWith(
      repository,
      mandate.userId,
      "verification_started",
      { action: challenge.action, amountCents: parsed.expenseAmountCents },
      messageId,
    );
    return {
      text: `That could change what feels safe. ${verificationCopy(challenge)}`,
      verification: challenge,
    };
  }

  private async recordLifeEvent(
    repository: PennyRepository,
    mandate: Mandate,
    parsed: Interpretation,
    messageId: string,
  ): Promise<PennyReply> {
    if (parsed.expenseAmountCents === null)
      return { text: "About how much might that unexpected expense cost?" };
    const expense: Expense = {
      id: `exp_${randomUUID()}`,
      label: parsed.expenseLabel ?? "unexpected expense",
      amountCents: parsed.expenseAmountCents,
      essential: true,
      active: true,
      horizonDays: parsed.expenseHorizonDays ?? 30,
    };
    const expenses = [...mandate.expenses, expense];
    const safety = evaluateSafety(
      {
        ...(mandate.availableCashCents !== undefined
          ? { availableCashCents: mandate.availableCashCents }
          : {}),
        expenses,
        riskPreference: mandate.riskPreference,
        obligationIncreaseCents: expense.amountCents,
      },
      this.now(),
    );
    const proposal = await repository.createProposal(
      enrichBrokerageProposal(
        {
          id: `prp_${randomUUID()}`,
          userId: mandate.userId,
          mandateVersion: mandate.version + 1,
          protectedCashCents: safety.protectedCashCents,
          investableCashCents: safety.investableCashCents,
          requestedAmountCents: expense.amountCents,
          reasonCodes: [
            ...new Set([
              ...safety.reasonCodes,
              "EMERGENCY_EXPENSE_REPORTED",
              "WITHDRAWAL_MAY_BE_NEEDED",
            ]),
          ] as Proposal["reasonCodes"],
          type: "pause",
          status: "AWAITING_CONFIRMATION",
          idempotencyKey: `life-event:${messageId}`,
          createdAt: this.now().toISOString(),
        },
        mandate.riskPreference === "unknown"
          ? "medium"
          : mandate.riskPreference,
        this.now(),
      ),
    );
    await repository.saveMandate({
      ...mandate,
      expenses,
      protectedCashCents: safety.protectedCashCents,
      pendingProposalId: proposal.id,
      version: mandate.version + 1,
    });
    await this.auditWith(
      repository,
      mandate.userId,
      "life_event_recorded",
      {
        eventType: parsed.eventType,
        amountCents: expense.amountCents,
        reasonCodes: proposal.reasonCodes,
      },
      messageId,
    );
    const text = `I’m sorry—that ${formatDollars(expense.amountCents)} ${expense.label} matters more than the simulation. I saved it and recalculated your capacity. I recommend pausing future simulated contributions or exploring a paper withdrawal; I won’t change anything until you choose and verify.`;
    return {
      text,
      parts: [
        { type: "text", text },
        {
          type: "poll",
          title: "How should Penny adapt?",
          options: [
            "Pause contributions",
            "Explore withdrawing money",
            "Keep my current plan",
          ],
        },
      ],
    };
  }

  private async recordIncomeChange(
    repository: PennyRepository,
    mandate: Mandate,
    parsed: Interpretation,
    messageId: string,
  ): Promise<PennyReply> {
    if (parsed.expenseAmountCents === null)
      return {
        text:
          parsed.intent === "report_bonus"
            ? "How much was the bonus?"
            : "How much is the recurring raise?",
      };
    const recurring = parsed.intent === "report_raise";
    const change: IncomeChange = {
      id: `inc_${randomUUID()}`,
      type: recurring ? "raise" : "bonus",
      label: parsed.expenseLabel ?? (recurring ? "raise" : "bonus"),
      amountCents: parsed.expenseAmountCents,
      recurring,
      createdAt: this.now().toISOString(),
    };
    await repository.saveMandate({
      ...mandate,
      incomeChanges: [...(mandate.incomeChanges ?? []), change],
      version: mandate.version + 1,
    });
    await this.auditWith(
      repository,
      mandate.userId,
      "income_change_recorded",
      {
        type: change.type,
        amountCents: change.amountCents,
        reasonCode: recurring
          ? "RECURRING_INCOME_INCREASED"
          : "BONUS_AVAILABLE",
      },
      messageId,
    );
    return {
      text: recurring
        ? `I saved the ${formatDollars(change.amountCents)} recurring raise. I can propose a higher simulated contribution, but I won’t change it without your approval and verification.`
        : `I saved the ${formatDollars(change.amountCents)} bonus. Your protected needs still come first; I can propose adding part of it to the paper portfolio after approval.`,
      parts: [
        {
          type: "poll",
          title: recurring
            ? "Review a contribution increase?"
            : "What should Penny do with the bonus?",
          options: ["Propose an increase", "Keep it protected", "Not now"],
        },
      ],
    };
  }

  private async requestWithdrawal(
    repository: PennyRepository,
    context: UserContext,
    parsed: Interpretation,
    messageId: string,
  ): Promise<PennyReply> {
    if (!context.simulation)
      return { text: "There is no active paper portfolio to withdraw from." };
    const pending = context.pendingProposal;
    const amount = parsed.expenseAmountCents ?? pending?.requestedAmountCents;
    if (!amount)
      return {
        text: `How much of the ${formatDollars(context.simulation.currentCents)} paper portfolio would you like to simulate withdrawing?`,
      };
    const bounded = Math.min(amount, context.simulation.currentCents);
    const challenge = await this.verification.start(
      "withdraw",
      `withdraw:${context.user.id}:${bounded}:${context.mandate.version}`,
    );
    await this.auditWith(
      repository,
      context.user.id,
      "verification_started",
      {
        action: "withdraw",
        amountCents: bounded,
      },
      messageId,
    );
    return {
      text: `A ${formatDollars(bounded)} simulated withdrawal would change your mandate. ${verificationCopy(challenge)}`,
      verification: challenge,
    };
  }

  private async requestContributionIncrease(
    repository: PennyRepository,
    context: UserContext,
    parsed: Interpretation,
    messageId: string,
  ): Promise<PennyReply> {
    const change = context.mandate.incomeChanges.at(-1);
    const amount = parsed.expenseAmountCents ?? change?.amountCents;
    if (!amount)
      return { text: "How much should the simulated contribution increase?" };
    if (!context.simulation)
      return {
        text: "Approve an initial paper mandate before increasing simulated contributions.",
      };
    const recurring = change?.recurring === true;
    const challenge = await this.verification.start(
      "increase_contribution",
      `contribution:${context.user.id}:${amount}:${recurring ? "recurring" : "once"}:${context.mandate.version}`,
    );
    await this.auditWith(
      repository,
      context.user.id,
      "verification_started",
      { action: "increase_contribution", amountCents: amount, recurring },
      messageId,
    );
    return {
      text: `Adding ${formatDollars(amount)} to the paper portfolio${recurring ? " and its recurring contribution" : ""} changes your mandate. ${verificationCopy(challenge)}`,
      verification: challenge,
    };
  }

  async completeVerification(
    userId: string,
    challenge: PendingVerification,
    identity: VerifiedIdentity,
  ): Promise<string> {
    return this.repository.transaction((repository) =>
      this.completeVerificationWith(repository, userId, challenge, identity),
    );
  }

  private async completeVerificationWith(
    repository: PennyRepository,
    userId: string,
    challenge: PendingVerification,
    identity: VerifiedIdentity,
  ): Promise<string> {
    await repository.lockUser(userId);
    const user = await repository.getUser(userId);
    if (!user) throw new Error("Unknown Penny user");
    const mandate = user.mandate;
    if (challenge.expiresAt <= Date.now())
      throw new Error("Verification challenge expired");
    if (
      (user.auth0Subject && user.auth0Subject !== identity.subject) ||
      (mandate.verifiedSubject && mandate.verifiedSubject !== identity.subject)
    )
      throw new Error("Verified identity does not match this Penny user");
    // Validate action binding before linking a durable identity.
    if (challenge.action === "approve_plan") {
      const proposal = await repository.getProposal(challenge.resourceId);
      if (!proposal || proposal.userId !== userId)
        throw new Error("Verification is not bound to this proposal and user");
      await repository.linkAuth0Subject(userId, identity.subject);
      await this.auditWith(repository, userId, "verification_succeeded", {
        action: challenge.action,
        subjectDigest: digest(identity.subject),
      });
      if (
        proposal.status === "approved" ||
        proposal.status === "EXECUTED" ||
        proposal.status === "PARTIALLY_FILLED"
      ) {
        const existing = await repository.getSimulationByUser(userId);
        if (!existing)
          await repository.saveSimulation(
            startSimulation(userId, proposal.id, proposal.investableCashCents),
          );
        return "That simulated plan was already approved; no duplicate action was taken.";
      }
      if (
        mandate.pendingProposalId !== proposal.id ||
        proposal.mandateVersion !== mandate.version ||
        !proposal.confirmedAt ||
        !proposal.expiresAt ||
        new Date(proposal.expiresAt).getTime() <= this.now().getTime()
      )
        throw new Error("Proposal is stale");
      const simulation = startSimulation(
        userId,
        proposal.id,
        proposal.investableCashCents,
        2_950,
        proposal.riskPreference && proposal.riskPreference !== "unknown"
          ? proposal.riskPreference
          : mandate.riskPreference === "unknown"
            ? "medium"
            : mandate.riskPreference,
      );
      if (this.brokerage.provider === "unavailable") {
        await repository.saveProposal({ ...proposal, status: "approved" });
        await repository.saveSimulation(simulation);
        const { pendingProposalId: _pending, ...withoutPending } = mandate;
        await repository.saveMandate({
          ...withoutPending,
          approvedProposalId: proposal.id,
          verifiedSubject: identity.subject,
          verifiedAt: identity.verifiedAt,
          version: mandate.version + 1,
        });
        await this.auditWith(repository, userId, "simulation_started", {
          proposalId: proposal.id,
          simulatedInitialCents: simulation.initialCents,
          protectedCashCents: proposal.protectedCashCents,
          provider: "explicit_local_simulation",
        });
        return `Verified ✅ Your ${formatDollars(simulation.initialCents)} simulated paper portfolio is active in explicitly local mode. ${formatDollars(proposal.protectedCashCents)} remains protected. No brokerage provider was configured and no order was sent. No real money moved.`;
      }
      await repository.saveProposal({ ...proposal, status: "VERIFIED" });
      await repository.saveProposal({ ...proposal, status: "SUBMITTING" });
      let execution: { status: "EXECUTED" | "PARTIALLY_FILLED"; text: string };
      try {
        execution = await this.executeBrokerageProposal(
          repository,
          userId,
          proposal,
        );
      } catch (error) {
        const code =
          error instanceof BrokerageError
            ? error.code
            : error instanceof Error
              ? error.message
              : "BROKERAGE_FAILURE";
        await repository.saveProposal({ ...proposal, status: "REJECTED" });
        await this.auditWith(repository, userId, "brokerage_rejected", {
          proposalId: proposal.id,
          errorCode: code,
        });
        return `Verified, but Alpaca sandbox is unavailable or rejected the request (${code}). I placed no additional orders. Your protected ${formatDollars(proposal.protectedCashCents)} remains untouched.`;
      }
      await repository.saveProposal({ ...proposal, status: execution.status });
      await repository.saveSimulation(simulation);
      const { pendingProposalId: _pending, ...withoutPending } = mandate;
      await repository.saveMandate({
        ...withoutPending,
        approvedProposalId: proposal.id,
        verifiedSubject: identity.subject,
        verifiedAt: identity.verifiedAt,
        version: mandate.version + 1,
      });
      await this.auditWith(
        repository,
        userId,
        "brokerage_execution_completed",
        {
          proposalId: proposal.id,
          simulatedInitialCents: simulation.initialCents,
          protectedCashCents: proposal.protectedCashCents,
          provider: this.brokerage.provider,
          status: execution.status,
        },
      );
      return execution.text;
    }
    if (challenge.action === "change_mandate") {
      const [kind, boundUser, amountText, encodedLabel] =
        challenge.resourceId.split(":");
      if (
        kind !== "change" ||
        boundUser !== userId ||
        !amountText ||
        !encodedLabel
      )
        throw new Error("Verification is not bound to this mandate change");
      await this.recordSuccessfulVerification(
        repository,
        userId,
        challenge,
        identity,
      );
      const amountCents = Number(amountText);
      const expense: Expense = {
        id: `exp_${randomUUID()}`,
        label: decodeURIComponent(encodedLabel),
        amountCents,
        essential: true,
        horizonDays: 30,
      };
      const expenses = [...mandate.expenses, expense];
      const safety = evaluateSafety(
        {
          ...(mandate.availableCashCents !== undefined
            ? { availableCashCents: mandate.availableCashCents }
            : {}),
          expenses,
          riskPreference: mandate.riskPreference,
          obligationIncreaseCents: amountCents,
        },
        this.now(),
      );
      await repository.saveMandate({
        ...mandate,
        expenses,
        protectedCashCents: safety.protectedCashCents,
        contributionsPaused: safety.pauseContributions,
        verifiedSubject: identity.subject,
        verifiedAt: identity.verifiedAt,
        version: mandate.version + 1,
      });
      await this.auditWith(repository, userId, "mandate_changed", {
        amountCents,
        reasonCodes: safety.reasonCodes,
        contributionsPaused: safety.pauseContributions,
      });
      return `Verified. I updated your living mandate for the ${formatDollars(amountCents)} increase. I recommend pausing future simulated contributions so real-life needs stay first.`;
    }
    if (challenge.action === "change_risk") {
      const [kind, boundUser, risk, versionText] =
        challenge.resourceId.split(":");
      if (
        kind !== "risk" ||
        boundUser !== userId ||
        !["low", "medium", "high"].includes(risk ?? "") ||
        Number(versionText) !== mandate.version
      )
        throw new Error("Verification is not bound to this risk change");
      await this.recordSuccessfulVerification(
        repository,
        userId,
        challenge,
        identity,
      );
      await repository.saveMandate({
        ...mandate,
        riskPreference: risk as "low" | "medium" | "high",
        verifiedSubject: identity.subject,
        verifiedAt: identity.verifiedAt,
        version: mandate.version + 1,
      });
      return `Verified. Your mandate is now ${titleCase(risk!)} risk. Penny will use the new model allocation on the next approved rebalance.`;
    }
    if (challenge.action === "withdraw") {
      const [kind, boundUser, amountText, versionText] =
        challenge.resourceId.split(":");
      if (
        kind !== "withdraw" ||
        boundUser !== userId ||
        Number(versionText) !== mandate.version
      )
        throw new Error("Verification is not bound to this withdrawal");
      await this.recordSuccessfulVerification(
        repository,
        userId,
        challenge,
        identity,
      );
      const amountCents = Number(amountText);
      const portfolio = await repository.getSimulationByUser(userId);
      if (!portfolio) throw new Error("No active paper portfolio");
      const updated = withdrawFromPortfolio(portfolio, amountCents, this.now());
      await repository.saveSimulation(updated);
      await repository.saveMandate({
        ...mandate,
        verifiedSubject: identity.subject,
        verifiedAt: identity.verifiedAt,
        version: mandate.version + 1,
      });
      await this.auditWith(repository, userId, "simulated_withdrawal", {
        amountCents,
      });
      return `Verified. I simulated a ${formatDollars(amountCents)} withdrawal. The paper portfolio is now ${formatDollars(updated.currentCents)}. No real money moved.`;
    }
    if (challenge.action === "increase_contribution") {
      const [kind, boundUser, amountText, cadence, versionText] =
        challenge.resourceId.split(":");
      if (
        kind !== "contribution" ||
        boundUser !== userId ||
        Number(versionText) !== mandate.version ||
        !["once", "recurring"].includes(cadence ?? "")
      )
        throw new Error(
          "Verification is not bound to this contribution change",
        );
      await this.recordSuccessfulVerification(
        repository,
        userId,
        challenge,
        identity,
      );
      const amountCents = Number(amountText);
      const portfolio = await repository.getSimulationByUser(userId);
      if (!portfolio) throw new Error("No active paper portfolio");
      const updated = contributeToPortfolio(portfolio, amountCents, this.now());
      await repository.saveSimulation(updated);
      await repository.saveMandate({
        ...mandate,
        recurringContributionCents:
          cadence === "recurring"
            ? (mandate.recurringContributionCents ?? 0) + amountCents
            : (mandate.recurringContributionCents ?? 0),
        verifiedSubject: identity.subject,
        verifiedAt: identity.verifiedAt,
        version: mandate.version + 1,
      });
      await this.auditWith(
        repository,
        userId,
        "simulated_contribution_increased",
        {
          amountCents,
          recurring: cadence === "recurring",
        },
      );
      return `Verified. I added ${formatDollars(amountCents)} to the diversified paper portfolio${cadence === "recurring" ? " and updated the recurring simulated contribution" : ""}. No real money moved.`;
    }
    if (challenge.resourceId !== userId)
      throw new Error("Verification is not bound to this user action");
    await this.recordSuccessfulVerification(
      repository,
      userId,
      challenge,
      identity,
    );
    if (challenge.action === "reset") {
      const simulation = await repository.getSimulationByUser(userId);
      if (simulation)
        await repository.saveSimulation({
          ...simulation,
          currentCents: simulation.initialCents,
          tick: 0,
          status: "reset",
        });
      await repository.saveMandate({
        ...mandate,
        approvedProposalId: undefined,
        contributionsPaused: false,
        verifiedSubject: identity.subject,
        verifiedAt: identity.verifiedAt,
        version: mandate.version + 1,
      });
      return "Verified. The paper simulation was reset. No real money moved.";
    }
    const paused = challenge.action === "pause";
    await repository.saveMandate({
      ...mandate,
      contributionsPaused: paused,
      verifiedSubject: identity.subject,
      verifiedAt: identity.verifiedAt,
      version: mandate.version + 1,
    });
    return `Verified. Future simulated contributions are ${paused ? "paused" : "resumed"}. No real money moved.`;
  }

  private async executeBrokerageProposal(
    repository: PennyRepository,
    userId: string,
    proposal: Proposal,
  ): Promise<{ status: "EXECUTED" | "PARTIALLY_FILLED"; text: string }> {
    const now = this.now().toISOString();
    let storedAccount = await repository.getBrokerageAccount(userId);
    const account = await this.brokerage.createOrRetrieveAccount({
      accountId: storedAccount?.accountId ?? this.brokerageConfig.demoAccountId,
      application: this.brokerageConfig.accountApplication,
    });
    storedAccount = {
      userId,
      provider: account.provider,
      accountId: account.accountId,
      ...(account.accountNumber
        ? { accountNumber: account.accountNumber }
        : {}),
      status: account.status,
      buyingPowerCents: account.buyingPowerCents,
      updatedAt: now,
    };
    await repository.saveBrokerageAccount(storedAccount);
    await this.auditWith(repository, userId, "brokerage_account_ready", {
      provider: account.provider,
      accountRef: digest(account.accountId),
      status: account.status,
    });

    let accountSnapshot = await this.brokerage.getAccountSnapshot(
      account.accountId,
    );
    const requiredFunding = Math.max(
      0,
      proposal.investableCashCents - accountSnapshot.buyingPowerCents,
    );
    const transferKey = `fund:${proposal.id}`;
    if (requiredFunding > 0) {
      const existing = await repository.getBrokerageTransferByKey(transferKey);
      if (!existing) {
        const transfer = await this.brokerage.fundSandbox({
          accountId: account.accountId,
          amountCents: requiredFunding,
          relationshipId: this.brokerageConfig.achRelationshipId ?? "",
          idempotencyKey: transferKey,
        });
        await repository.saveBrokerageTransfer({
          id: `btr_${randomUUID()}`,
          userId,
          proposalId: proposal.id,
          providerTransferId: transfer.id,
          direction: transfer.direction,
          amountCents: transfer.amountCents,
          status: transfer.status,
          idempotencyKey: transferKey,
          createdAt: now,
          updatedAt: now,
        });
        await this.auditWith(repository, userId, "sandbox_transfer_requested", {
          proposalId: proposal.id,
          transferRef: digest(transfer.id),
          amountCents: transfer.amountCents,
          status: transfer.status,
        });
      }
      accountSnapshot = await this.brokerage.getAccountSnapshot(
        account.accountId,
      );
    }

    const expectedOrders = proposal.expectedOrders ?? [];
    assertOrderCap(
      expectedOrders,
      proposal.investableCashCents,
      proposal.investableCashCents,
      accountSnapshot.buyingPowerCents,
    );
    const existingOrders = await repository.listBrokerageOrders(proposal.id);
    const records = [...existingOrders];
    for (const [index, expected] of expectedOrders.entries()) {
      const clientOrderId = `${proposal.id.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 36)}-${index}`;
      if (records.some((item) => item.clientOrderId === clientOrderId))
        continue;
      const order = await this.brokerage.submitOrder({
        accountId: account.accountId,
        symbol: expected.symbol,
        notionalCents: expected.notionalCents,
        side: expected.side,
        clientOrderId,
      });
      const record = {
        id: `bor_${randomUUID()}`,
        userId,
        proposalId: proposal.id,
        providerOrderId: order.id,
        clientOrderId: order.clientOrderId,
        symbol: order.symbol,
        side: order.side,
        notionalCents: expected.notionalCents,
        status: order.status,
        createdAt: now,
        updatedAt: now,
      } as const;
      await repository.saveBrokerageOrder(record);
      records.push(record);
      await this.auditWith(repository, userId, "brokerage_order_submitted", {
        proposalId: proposal.id,
        orderRef: digest(order.id),
        symbol: order.symbol,
        notionalCents: expected.notionalCents,
        status: order.status,
      });
    }
    const finalAccount = await this.brokerage.getAccountSnapshot(
      account.accountId,
    );
    const positions = await this.brokerage.getPositions(account.accountId);
    await repository.saveBrokerageSnapshot({
      id: `bsn_${randomUUID()}`,
      userId,
      accountId: account.accountId,
      portfolioValueCents: finalAccount.portfolioValueCents,
      cashCents: finalAccount.cashCents,
      buyingPowerCents: finalAccount.buyingPowerCents,
      positions,
      simulated: true,
      capturedAt: now,
    });
    const complete = records.every((order) =>
      ["filled", "accepted", "new", "partially_filled"].includes(
        order.status.toLowerCase(),
      ),
    );
    const status = complete ? "EXECUTED" : "PARTIALLY_FILLED";
    const orderSummary = records
      .map((order) => `${order.symbol} ${formatDollars(order.notionalCents)}`)
      .join(" and ");
    return {
      status,
      text: `Verified ✅ Alpaca sandbox received the simulated ${orderSummary} orders. ${formatDollars(proposal.protectedCashCents)} remains protected and ${formatDollars((proposal.allocation ?? []).find((item) => item.assetClass === "cash_equivalent")?.amountCents ?? 0)} remains sandbox cash. No real money moved.`,
    };
  }

  private async orderStatus(
    repository: PennyRepository,
    mandate: Mandate,
  ): Promise<PennyReply> {
    const proposalId = mandate.approvedProposalId ?? mandate.pendingProposalId;
    if (!proposalId)
      return {
        text: "There are no Alpaca sandbox orders for your Penny profile.",
      };
    const orders = await repository.listBrokerageOrders(proposalId);
    if (orders.length === 0)
      return {
        text: "No Alpaca sandbox orders have been submitted for that proposal yet.",
      };
    return {
      text: `Simulated Alpaca order status: ${orders.map((order) => `${order.symbol} ${formatDollars(order.notionalCents)} — ${order.status}`).join("; ")}.`,
    };
  }

  private async recordSuccessfulVerification(
    repository: PennyRepository,
    userId: string,
    challenge: PendingVerification,
    identity: VerifiedIdentity,
  ): Promise<void> {
    await repository.linkAuth0Subject(userId, identity.subject);
    await this.auditWith(repository, userId, "verification_succeeded", {
      action: challenge.action,
      subjectDigest: digest(identity.subject),
    });
  }

  async createProactiveUpdate(userId: string): Promise<string> {
    return (await this.createProactiveUpdateReply(userId)).text ?? "";
  }

  async createProactiveUpdateReply(userId: string): Promise<PennyReply> {
    return this.repository.transaction(async (repository) => {
      await repository.lockUser(userId);
      return this.createProactiveUpdateReplyWith(repository, userId);
    });
  }

  private async createProactiveUpdateReplyWith(
    repository: PennyRepository,
    userId: string,
  ): Promise<PennyReply> {
    const user = await repository.getUser(userId);
    const brokerageAccount = await repository.getBrokerageAccount(userId);
    if (user && brokerageAccount) {
      try {
        const account = await this.brokerage.getAccountSnapshot(
          brokerageAccount.accountId,
        );
        const positions = await this.brokerage.getPositions(
          brokerageAccount.accountId,
        );
        const previous = await repository.getBrokerageSnapshot(userId);
        const snapshot = {
          id: `bsn_${randomUUID()}`,
          userId,
          accountId: brokerageAccount.accountId,
          portfolioValueCents: account.portfolioValueCents,
          cashCents: account.cashCents,
          buyingPowerCents: account.buyingPowerCents,
          positions,
          simulated: true as const,
          capturedAt: this.now().toISOString(),
        };
        await repository.saveBrokerageSnapshot(snapshot);
        const change = previous
          ? snapshot.portfolioValueCents - previous.portfolioValueCents
          : 0;
        await this.auditWith(repository, userId, "brokerage_weekly_snapshot", {
          snapshotId: snapshot.id,
          portfolioValueCents: snapshot.portfolioValueCents,
          positionCount: positions.length,
        });
        return {
          text: `Good morning! Your simulated Alpaca sandbox portfolio is ${formatDollars(snapshot.portfolioValueCents)} (${change >= 0 ? "+" : "-"}${formatDollars(Math.abs(change))} since the last snapshot). ${formatDollars(user.mandate.protectedCashCents)} remains protected outside the orders. Holdings: ${positions.map((position) => `${position.symbol} ${formatDollars(position.marketValueCents)}`).join(", ") || "sandbox cash only"}.`,
        };
      } catch (error) {
        const code =
          error instanceof BrokerageError
            ? error.code
            : "BROKERAGE_UNAVAILABLE";
        await this.auditWith(repository, userId, "brokerage_weekly_failed", {
          errorCode: code,
        });
        return {
          text: `I couldn’t retrieve your simulated Alpaca sandbox update (${code}). I did not place or change any orders.`,
        };
      }
    }
    const simulation = await repository.getSimulationByUser(userId);
    if (!user || !simulation) throw new Error("No active simulation");
    const updated = advancePortfolioWeek(
      simulation,
      user.mandate.protectedCashCents,
      undefined,
      this.now(),
    );
    await repository.saveSimulation(updated);
    await this.auditWith(repository, userId, "simulation_tick", {
      tick: updated.tick,
      simulatedBalanceCents: updated.currentCents,
    });
    const label =
      user.mandate.expenses.find((expense) => expense.essential)?.label ??
      "protected";
    const snapshot = updated.weeklySnapshots.at(-1)!;
    const direction = snapshot.changeCents >= 0 ? "up" : "down";
    const text = `Your paper portfolio is ${direction} ${formatDollars(Math.abs(snapshot.changeCents))} this week and is now ${formatDollars(updated.currentCents)}. Your ${formatDollars(user.mandate.protectedCashCents)} ${label} reserve is still separate.${snapshot.rebalanced ? ` I rebalanced within your ${titleCase(updated.riskPreference)}-risk plan.` : " Allocations stayed within the rebalance threshold."} Nothing needs your attention.`;
    return {
      text,
      parts: [
        {
          type: "text",
          text: "Good morning! Your weekly Penny update is ready 🌱",
        },
        portfolioCardPart(
          updated,
          user.mandate.protectedCashCents,
          snapshot.rebalanced,
        ),
        { type: "text", text },
      ],
    };
  }

  private async audit(
    userId: string,
    type: string,
    payload: Record<string, unknown>,
    originalMessageId?: string,
  ): Promise<void> {
    const event: AuditEvent = {
      id: `aud_${randomUUID()}`,
      userId,
      type,
      ...(originalMessageId ? { originalMessageId } : {}),
      payload,
      createdAt: this.now().toISOString(),
    };
    await this.repository.appendAudit(event);
  }

  private async auditWith(
    repository: PennyRepository,
    userId: string,
    type: string,
    payload: Record<string, unknown>,
    originalMessageId?: string,
  ): Promise<void> {
    const event: AuditEvent = {
      id: `aud_${randomUUID()}`,
      userId,
      type,
      ...(originalMessageId ? { originalMessageId } : {}),
      payload,
      createdAt: this.now().toISOString(),
    };
    await repository.appendAudit(event);
  }
}

function verificationCopy(challenge: PendingVerification): string {
  const url = challenge.verificationUriComplete ?? challenge.verificationUri;
  return `Please verify this action with Auth0: ${url} (code ${challenge.userCode}). I’ll continue only after Auth0 confirms you.`;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function normalizeLabel(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .replace(/s$/, "");
}

function findExpense(
  expenses: Expense[],
  label: string | null,
): Expense | undefined {
  if (!label) return expenses.at(-1);
  const wanted = normalizeLabel(label);
  return expenses.find((expense) => {
    const current = normalizeLabel(expense.label);
    return (
      current === wanted || current.includes(wanted) || wanted.includes(current)
    );
  });
}

function planSummary(mandate: Mandate): string {
  if (mandate.availableCashCents === undefined && mandate.expenses.length === 0)
    return "I don’t have any stored financial details for you yet.";
  const available = mandate.availableCashCents ?? 0;
  const remaining = Math.max(0, available - mandate.protectedCashCents);
  const expenseText = mandate.expenses.length
    ? mandate.expenses
        .map(
          (expense) =>
            `${formatDollars(expense.amountCents)} for ${expense.label}`,
        )
        .join(", ")
    : "no upcoming expenses";
  return `Yes, I remember—you have ${expenseText}. We’re keeping ${formatDollars(mandate.protectedCashCents)} safe, leaving ${formatDollars(remaining)} available for your paper-investing plan.`;
}

function interpreterContext(context: UserContext) {
  return {
    ...(context.memory?.conciseSummary
      ? { summary: context.memory.conciseSummary }
      : {}),
    unresolvedQuestions: context.memory?.unresolvedQuestions ?? [],
    ...(context.mandate.availableCashCents !== undefined
      ? { availableCashCents: context.mandate.availableCashCents }
      : {}),
    protectedCashCents: context.mandate.protectedCashCents,
    activeExpenses: context.mandate.expenses
      .filter((expense) => expense.active !== false)
      .map((expense) => ({
        label: expense.label,
        amountCents: expense.amountCents,
      })),
    riskPreference: context.mandate.riskPreference,
    planStatus: context.simulation
      ? ("active" as const)
      : context.pendingProposal
        ? ("pending" as const)
        : ("none" as const),
  };
}

function buildMemory(context: UserContext, parsed: Interpretation) {
  return {
    userId: context.user.id,
    conciseSummary: planSummary(context.mandate),
    unresolvedQuestions: parsed.missingInformation,
    lastIntent: parsed.intent,
    updatedAt: new Date().toISOString(),
  };
}

function deterministicMemoryIntent(text: string): Interpretation | undefined {
  const lower = text.toLowerCase();
  let intent: Interpretation["intent"] | undefined;
  let expenseLabel: string | null = null;
  let confirmation: string | null = null;
  const confirmationMatch = /^CONFIRM\s+([A-Z0-9]{4,12})$/i.exec(text.trim());
  if (confirmationMatch) {
    intent = "confirm_proposal";
    confirmation = confirmationMatch[1]!.toUpperCase();
  } else if (/\bforget (me|everything|all my data)\b/i.test(text))
    intent = "forget_me";
  else if (
    /\b(forget|remove|delete)\b/i.test(text) &&
    /\b(expense|rent|textbooks?|bill)\b/i.test(text)
  ) {
    intent = "forget_expense";
    expenseLabel = lower.includes("textbook")
      ? "textbooks"
      : lower.includes("rent")
        ? "rent"
        : null;
  } else if (/what do you remember|remember about me/i.test(text))
    intent = "recall_memory";
  else if (
    /what(?:'s| is) my plan|how much.*(?:safe|protected|available)|keeping safe/i.test(
      text,
    )
  )
    intent = "ask_plan";
  if (!intent) return undefined;
  return {
    intent,
    availableAmountCents: null,
    expenseLabel,
    expenseAmountCents: null,
    expenseDueDate: null,
    expenseHorizonDays: null,
    eventType: null,
    essential: null,
    riskPreference: null,
    userQuestion: text.includes("?") ? text.slice(0, 300) : null,
    confidence: 1,
    missingInformation: [],
    suggestedClarificationQuestion: null,
    confirmationCode: confirmation,
  };
}

function enrichBrokerageProposal(
  proposal: Proposal,
  risk: "low" | "medium" | "high",
  now: Date,
): Proposal {
  const { allocation, orders } = createBrokerageAllocation(
    proposal.investableCashCents,
    risk,
  );
  return {
    ...proposal,
    riskPreference: risk,
    confirmationCode: confirmationCode(
      `${proposal.id}:${proposal.mandateVersion}:${proposal.protectedCashCents}:${proposal.investableCashCents}:${risk}`,
    ),
    expiresAt: new Date(now.getTime() + 10 * 60_000).toISOString(),
    allocation,
    expectedOrders: orders,
    explanation:
      "Essential money remains protected; only the confirmed remainder may enter the simulated sandbox portfolio.",
  };
}

function portfolioCardPart(
  portfolio: import("../domain/types.js").Simulation,
  protectedCashCents: number,
  rebalanced: boolean,
): Extract<PennyReplyPart, { type: "image" }> {
  const weekly = portfolio.weeklySnapshots.at(-1);
  const rows = portfolio.positions
    .map((position, index) => {
      const label =
        position.assetClass === "cash_equivalent"
          ? "Cash equivalent"
          : titleCase(position.assetClass);
      const percent = (
        (position.valueCents / Math.max(1, portfolio.currentCents)) *
        100
      ).toFixed(0);
      const y = 322 + index * 54;
      const width = Math.max(
        2,
        Math.round(
          (position.valueCents / Math.max(1, portfolio.currentCents)) * 420,
        ),
      );
      return `<text x="52" y="${y}" class="label">${label}</text><text x="548" y="${y}" text-anchor="end" class="label">${percent}% · ${formatDollars(position.valueCents)}</text><rect x="52" y="${y + 14}" width="420" height="12" rx="6" fill="#dbe9df"/><rect x="52" y="${y + 14}" width="${width}" height="12" rx="6" fill="#2f7d55"/>`;
    })
    .join("");
  const change = weekly?.changeCents ?? 0;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="560" viewBox="0 0 600 560"><rect width="600" height="560" rx="36" fill="#f7fbf7"/><style>.brand{font:700 28px -apple-system,BlinkMacSystemFont,sans-serif;fill:#174a33}.value{font:700 44px -apple-system,BlinkMacSystemFont,sans-serif;fill:#102a20}.label{font:500 18px -apple-system,BlinkMacSystemFont,sans-serif;fill:#294c3e}.small{font:500 15px -apple-system,BlinkMacSystemFont,sans-serif;fill:#557267}</style><text x="52" y="62" class="brand">Penny · simulated portfolio</text><text x="52" y="124" class="value">${formatDollars(portfolio.currentCents)}</text><text x="52" y="158" class="label">Weekly change: ${change >= 0 ? "+" : ""}${formatDollars(change)}</text><rect x="42" y="190" width="516" height="82" rx="20" fill="#e7f3e9"/><text x="62" y="226" class="label">Protected cash</text><text x="538" y="226" text-anchor="end" class="label">${formatDollars(protectedCashCents)}</text><text x="62" y="254" class="small">Invested ${formatDollars(portfolio.currentCents)} · ${titleCase(portfolio.riskPreference)} risk</text>${rows}<text x="52" y="518" class="small">${rebalanced ? "Rebalanced automatically within mandate" : "No action required"} · Paper simulation only</text></svg>`;
  return {
    type: "image",
    name: `penny-portfolio-week-${portfolio.tick}.svg`,
    mimeType: "image/svg+xml",
    data: Buffer.from(svg),
  };
}

function titleCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1).replaceAll("_", " ");
}
