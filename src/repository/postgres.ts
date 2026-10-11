import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import type {
  AuditEvent,
  ConversationMemory,
  Mandate,
  Proposal,
  Simulation,
  UserRecord,
  UserContext,
} from "../domain/types.js";
import type { PennyRepository } from "./repository.js";

export class PostgresRepository implements PennyRepository {
  constructor(
    private readonly pool: Pick<Pool, "query">,
    private readonly rootPool?: Pool,
    private readonly inTransaction = false,
  ) {}

  static connect(connectionString: string): PostgresRepository {
    const pool = new Pool({
      connectionString,
      ssl: connectionString.includes("localhost")
        ? false
        : { rejectUnauthorized: false },
    });
    return new PostgresRepository(pool, pool);
  }

  async transaction<T>(
    operation: (repository: PennyRepository) => Promise<T>,
  ): Promise<T> {
    if (this.inTransaction) return operation(this);
    if (!this.rootPool) throw new Error("PostgreSQL pool is unavailable");
    const client: PoolClient = await this.rootPool.connect();
    try {
      await client.query("BEGIN");
      const result = await operation(
        new PostgresRepository(client, this.rootPool, true),
      );
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async lockUser(userId: string): Promise<void> {
    if (!this.inTransaction)
      throw new Error("User locks require a repository transaction");
    await this.pool.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      userId,
    ]);
  }

  async claimMessage(messageId: string): Promise<boolean> {
    const result = await this.pool.query(
      `INSERT INTO message_receipts(message_id, status) VALUES($1, 'processing')
       ON CONFLICT(message_id) DO UPDATE SET updated_at=now()
       WHERE message_receipts.status='processing'
         AND message_receipts.updated_at < now() - interval '2 minutes'
       RETURNING message_id`,
      [messageId],
    );
    if (result.rowCount === 1)
      await this.pool.query(
        `INSERT INTO message_events(provider_message_id,direction,processing_status)
         VALUES($1,'inbound','processing')
         ON CONFLICT(provider_message_id) DO UPDATE SET processing_status='processing'`,
        [messageId],
      );
    return result.rowCount === 1;
  }
  async completeMessage(messageId: string): Promise<void> {
    await this.pool.query(
      "UPDATE message_receipts SET status='completed', updated_at=now() WHERE message_id=$1",
      [messageId],
    );
    await this.pool.query(
      "UPDATE message_events SET processing_status='completed' WHERE provider_message_id=$1",
      [messageId],
    );
  }
  async releaseMessage(messageId: string): Promise<void> {
    await this.pool.query(
      "DELETE FROM message_receipts WHERE message_id=$1 AND status='processing'",
      [messageId],
    );
    await this.pool.query(
      "DELETE FROM message_events WHERE provider_message_id=$1 AND processing_status='processing'",
      [messageId],
    );
  }
  async attachMessageToUser(messageId: string, userId: string): Promise<void> {
    await this.pool.query(
      "UPDATE message_events SET user_id=$1 WHERE provider_message_id=$2",
      [userId, messageId],
    );
  }
  async recordMessageIntent(messageId: string, intent: string): Promise<void> {
    await this.pool.query(
      "UPDATE message_events SET intent=$1 WHERE provider_message_id=$2",
      [intent, messageId],
    );
  }

  async getOrCreateUser(
    photonUserId: string,
    photonSpaceId: string,
    consentVersion: string,
    legacySenderKey?: string,
  ): Promise<UserRecord> {
    const existing = await this.pool.query<{
      id: string;
      photon_user_id: string;
      photon_space_id: string;
      auth0_subject: string | null;
      verification_status: "unverified" | "verified" | "deleted";
      consent_version: string;
      mandate: Mandate;
    }>(
      `SELECT id, COALESCE(photon_user_id,sender_key) AS photon_user_id,
              COALESCE(photon_space_id,space_key) AS photon_space_id,
              auth0_subject, verification_status, COALESCE(consent_version,$3) AS consent_version, mandate
       FROM penny_users
       WHERE photon_user_id=$1 OR sender_key=$1 OR ($4::text IS NOT NULL AND sender_key=$4)
       LIMIT 1`,
      [photonUserId, photonSpaceId, consentVersion, legacySenderKey ?? null],
    );
    if (existing.rows[0]) {
      await this.pool.query(
        `UPDATE penny_users
         SET sender_key=$1, space_key=$2, photon_user_id=$1, photon_space_id=$2,
             consent_version=$3, updated_at=now()
         WHERE id=$4`,
        [photonUserId, photonSpaceId, consentVersion, existing.rows[0].id],
      );
      return rowToUser({
        ...existing.rows[0],
        photon_user_id: photonUserId,
        photon_space_id: photonSpaceId,
      });
    }
    const id = `usr_${randomUUID()}`;
    const mandate: Mandate = {
      userId: id,
      expenses: [],
      goals: [],
      incomeChanges: [],
      riskPreference: "unknown",
      protectedCashCents: 0,
      recurringContributionCents: 0,
      contributionsPaused: false,
      consentVersion,
      version: 1,
    };
    try {
      await this.pool.query(
        `INSERT INTO penny_users(
           id,sender_key,space_key,mandate,photon_user_id,photon_space_id,
           verification_status,consent_version
         ) VALUES($1,$2,$3,$4,$2,$3,'unverified',$5)`,
        [
          id,
          photonUserId,
          photonSpaceId,
          JSON.stringify(mandate),
          consentVersion,
        ],
      );
      await this.saveMandate(mandate);
      return {
        id,
        photonUserId,
        photonSpaceId,
        verificationStatus: "unverified",
        consentVersion,
        mandate,
      };
    } catch (error) {
      if ((error as { code?: string }).code !== "23505") throw error;
      return this.getOrCreateUser(
        photonUserId,
        photonSpaceId,
        consentVersion,
        legacySenderKey,
      );
    }
  }

  async getUser(userId: string): Promise<UserRecord | undefined> {
    const result = await this.pool.query<{
      id: string;
      photon_user_id: string;
      photon_space_id: string;
      auth0_subject: string | null;
      verification_status: "unverified" | "verified" | "deleted";
      consent_version: string;
      mandate: Mandate;
    }>(
      `SELECT id, COALESCE(photon_user_id,sender_key) AS photon_user_id,
              COALESCE(photon_space_id,space_key) AS photon_space_id,
              auth0_subject, verification_status, COALESCE(consent_version,mandate->>'consentVersion') AS consent_version,
              mandate
       FROM penny_users WHERE id=$1`,
      [userId],
    );
    return result.rows[0] ? rowToUser(result.rows[0]) : undefined;
  }
  async listUsersWithActivePortfolios(): Promise<UserRecord[]> {
    const result = await this.pool.query<{
      id: string;
      photon_user_id: string;
      photon_space_id: string;
      auth0_subject: string | null;
      verification_status: "unverified" | "verified" | "deleted";
      consent_version: string;
      mandate: Mandate;
    }>(
      `SELECT u.id,COALESCE(u.photon_user_id,u.sender_key) AS photon_user_id,
              COALESCE(u.photon_space_id,u.space_key) AS photon_space_id,
              u.auth0_subject,u.verification_status,
              COALESCE(u.consent_version,u.mandate->>'consentVersion') AS consent_version,u.mandate
       FROM penny_users u JOIN simulations s ON s.user_id=u.id
       WHERE s.status='active'`,
    );
    return result.rows.map(rowToUser);
  }
  async getUserContext(userId: string): Promise<UserContext | undefined> {
    const user = await this.getUser(userId);
    if (!user) return undefined;
    const memoryResult = await this.pool.query<{
      concise_summary: string;
      unresolved_questions: string[];
      last_intent: string | null;
      updated_at: Date;
    }>("SELECT * FROM conversation_memory WHERE user_id=$1", [userId]);
    const pendingProposal = user.mandate.pendingProposalId
      ? await this.getProposal(user.mandate.pendingProposalId)
      : undefined;
    const simulation = await this.getSimulationByUser(userId);
    const memoryRow = memoryResult.rows[0];
    return {
      user,
      mandate: user.mandate,
      ...(memoryRow
        ? {
            memory: {
              userId,
              conciseSummary: memoryRow.concise_summary,
              unresolvedQuestions: memoryRow.unresolved_questions,
              ...(memoryRow.last_intent
                ? { lastIntent: memoryRow.last_intent }
                : {}),
              updatedAt: memoryRow.updated_at.toISOString(),
            },
          }
        : {}),
      ...(pendingProposal ? { pendingProposal } : {}),
      ...(simulation ? { simulation } : {}),
    };
  }
  async saveMandate(mandate: Mandate): Promise<void> {
    await this.pool.query(
      "UPDATE penny_users SET mandate=$1, updated_at=now() WHERE id=$2",
      [JSON.stringify(mandate), mandate.userId],
    );
    await this.pool.query(
      `INSERT INTO mandates(user_id,available_cash_cents,time_horizon_days,risk_preference,
         protected_cash_cents,contributions_paused,approved_proposal_id,pending_proposal_id,
         consent_version,version,recurring_contribution_cents,updated_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,now())
       ON CONFLICT(user_id) DO UPDATE SET
         available_cash_cents=EXCLUDED.available_cash_cents,
         time_horizon_days=EXCLUDED.time_horizon_days,
         risk_preference=EXCLUDED.risk_preference,
         protected_cash_cents=EXCLUDED.protected_cash_cents,
         contributions_paused=EXCLUDED.contributions_paused,
         approved_proposal_id=EXCLUDED.approved_proposal_id,
         pending_proposal_id=EXCLUDED.pending_proposal_id,
         consent_version=EXCLUDED.consent_version,version=EXCLUDED.version,
         recurring_contribution_cents=EXCLUDED.recurring_contribution_cents,updated_at=now()`,
      [
        mandate.userId,
        mandate.availableCashCents ?? null,
        mandate.timeHorizonDays ?? null,
        mandate.riskPreference,
        mandate.protectedCashCents,
        mandate.contributionsPaused,
        mandate.approvedProposalId ?? null,
        mandate.pendingProposalId ?? null,
        mandate.consentVersion,
        mandate.version,
        mandate.recurringContributionCents ?? 0,
      ],
    );
    const expenseIds = mandate.expenses.map((expense) => expense.id);
    await this.pool.query(
      "UPDATE expenses SET active=false,updated_at=now() WHERE user_id=$1 AND NOT(id=ANY($2::text[]))",
      [mandate.userId, expenseIds],
    );
    for (const expense of mandate.expenses) {
      await this.pool.query(
        `INSERT INTO expenses(id,user_id,label,amount_cents,essential,due_at,horizon_days,active,updated_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,now()) ON CONFLICT(id) DO UPDATE SET
         label=EXCLUDED.label,amount_cents=EXCLUDED.amount_cents,essential=EXCLUDED.essential,
         due_at=EXCLUDED.due_at,horizon_days=EXCLUDED.horizon_days,active=EXCLUDED.active,updated_at=now()`,
        [
          expense.id,
          mandate.userId,
          expense.label,
          expense.amountCents,
          expense.essential,
          expense.dueAt ?? null,
          expense.horizonDays ?? null,
          expense.active !== false,
        ],
      );
    }
    const goalIds = mandate.goals.map((goal) => goal.id);
    await this.pool.query(
      "UPDATE goals SET active=false,updated_at=now() WHERE user_id=$1 AND NOT(id=ANY($2::text[]))",
      [mandate.userId, goalIds],
    );
    for (const goal of mandate.goals) {
      await this.pool.query(
        `INSERT INTO goals(id,user_id,label,target_amount_cents,target_date,priority,active,updated_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,now()) ON CONFLICT(id) DO UPDATE SET
         label=EXCLUDED.label,target_amount_cents=EXCLUDED.target_amount_cents,
         target_date=EXCLUDED.target_date,priority=EXCLUDED.priority,active=EXCLUDED.active,updated_at=now()`,
        [
          goal.id,
          mandate.userId,
          goal.label,
          goal.targetAmountCents ?? null,
          goal.targetDate ?? null,
          goal.priority,
          goal.active,
        ],
      );
    }
    for (const change of mandate.incomeChanges ?? []) {
      await this.pool.query(
        `INSERT INTO income_changes(id,user_id,type,label,amount_cents,recurring,effective_date,created_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(id) DO UPDATE SET
         type=EXCLUDED.type,label=EXCLUDED.label,amount_cents=EXCLUDED.amount_cents,
         recurring=EXCLUDED.recurring,effective_date=EXCLUDED.effective_date`,
        [
          change.id,
          mandate.userId,
          change.type,
          change.label,
          change.amountCents,
          change.recurring,
          change.effectiveDate ?? null,
          change.createdAt,
        ],
      );
    }
  }
  async saveConversationMemory(memory: ConversationMemory): Promise<void> {
    await this.pool.query(
      `INSERT INTO conversation_memory(user_id,concise_summary,unresolved_questions,last_intent,updated_at)
       VALUES($1,$2,$3,$4,$5) ON CONFLICT(user_id) DO UPDATE SET
       concise_summary=EXCLUDED.concise_summary,unresolved_questions=EXCLUDED.unresolved_questions,
       last_intent=EXCLUDED.last_intent,updated_at=EXCLUDED.updated_at`,
      [
        memory.userId,
        memory.conciseSummary,
        memory.unresolvedQuestions,
        memory.lastIntent ?? null,
        memory.updatedAt,
      ],
    );
  }
  async linkAuth0Subject(userId: string, subject: string): Promise<void> {
    await this.pool.query(
      "UPDATE penny_users SET auth0_subject=$2,verification_status='verified',updated_at=now() WHERE id=$1",
      [userId, subject],
    );
  }
  async deleteUserData(userId: string): Promise<void> {
    await this.pool.query("DELETE FROM conversation_memory WHERE user_id=$1", [
      userId,
    ]);
    await this.pool.query("DELETE FROM expenses WHERE user_id=$1", [userId]);
    await this.pool.query("DELETE FROM goals WHERE user_id=$1", [userId]);
    await this.pool.query("DELETE FROM simulations WHERE user_id=$1", [userId]);
    await this.pool.query("DELETE FROM proposals WHERE user_id=$1", [userId]);
    await this.pool.query("DELETE FROM mandates WHERE user_id=$1", [userId]);
    await this.pool.query(
      "UPDATE message_events SET user_id=NULL WHERE user_id=$1",
      [userId],
    );
    await this.pool.query(
      "UPDATE audit_events SET payload='{" +
        '"retainedFor":"security_and_idempotency"' +
        "}'::jsonb,user_id=NULL WHERE user_id=$1",
      [userId],
    );
    await this.pool.query("DELETE FROM penny_users WHERE id=$1", [userId]);
  }
  async createProposal(proposal: Proposal): Promise<Proposal> {
    const result = await this.pool.query<{ body: Proposal }>(
      `INSERT INTO proposals(id,user_id,idempotency_key,body,protected_amount_cents,
       simulated_investment_amount_cents,plan_type,reason_codes,status,created_at)
       VALUES($1,$2,$3,$4,$5,$6,'diversified_paper',$7,$8,$9)
       ON CONFLICT(idempotency_key) DO UPDATE SET idempotency_key=EXCLUDED.idempotency_key RETURNING body`,
      [
        proposal.id,
        proposal.userId,
        proposal.idempotencyKey,
        JSON.stringify(proposal),
        proposal.protectedCashCents,
        proposal.investableCashCents,
        proposal.reasonCodes,
        proposal.status,
        proposal.createdAt,
      ],
    );
    return result.rows[0]!.body;
  }
  async getProposal(id: string): Promise<Proposal | undefined> {
    const result = await this.pool.query<{ body: Proposal }>(
      "SELECT body FROM proposals WHERE id=$1",
      [id],
    );
    return result.rows[0]?.body;
  }
  async saveProposal(proposal: Proposal): Promise<void> {
    await this.pool.query(
      "UPDATE proposals SET body=$1,status=$3,approved_at=CASE WHEN $3='approved' THEN now() ELSE approved_at END WHERE id=$2",
      [JSON.stringify(proposal), proposal.id, proposal.status],
    );
  }
  async getSimulationByUser(userId: string): Promise<Simulation | undefined> {
    const result = await this.pool.query<{ body: Simulation }>(
      "SELECT body FROM simulations WHERE user_id=$1",
      [userId],
    );
    return result.rows[0]?.body;
  }
  async saveSimulation(simulation: Simulation): Promise<void> {
    if (!this.inTransaction && this.rootPool) {
      await this.transaction((repository) =>
        repository.saveSimulation(simulation),
      );
      return;
    }
    // Serialize portfolio writers for this user and replace an old portfolio
    // identity safely when a reset user activates a new proposal.
    await this.lockUser(simulation.userId);
    await this.pool.query(
      `INSERT INTO simulations(user_id,body,id,starting_amount_cents,current_value_cents,status,updated_at)
       VALUES($1,$2,$3,$4,$5,$6,now()) ON CONFLICT(user_id) DO UPDATE SET
       body=EXCLUDED.body,id=EXCLUDED.id,starting_amount_cents=EXCLUDED.starting_amount_cents,
       current_value_cents=EXCLUDED.current_value_cents,status=EXCLUDED.status,updated_at=now()`,
      [
        simulation.userId,
        JSON.stringify(simulation),
        simulation.id,
        simulation.initialCents,
        simulation.currentCents,
        simulation.status,
      ],
    );
    await this.pool.query(
      "DELETE FROM portfolios WHERE user_id=$1 AND id<>$2",
      [simulation.userId, simulation.id],
    );
    await this.pool.query(
      `INSERT INTO portfolios(id,user_id,proposal_id,risk_preference,seed,initial_cents,current_cents,week,status,updated_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,now()) ON CONFLICT(user_id) DO UPDATE SET
       proposal_id=EXCLUDED.proposal_id,risk_preference=EXCLUDED.risk_preference,
       seed=EXCLUDED.seed,initial_cents=EXCLUDED.initial_cents,current_cents=EXCLUDED.current_cents,
       week=EXCLUDED.week,status=EXCLUDED.status,updated_at=now()`,
      [
        simulation.id,
        simulation.userId,
        simulation.proposalId,
        simulation.riskPreference,
        simulation.seed,
        simulation.initialCents,
        simulation.currentCents,
        simulation.tick,
        simulation.status,
      ],
    );
    for (const position of simulation.positions) {
      await this.pool.query(
        `INSERT INTO portfolio_positions(portfolio_id,asset_class,target_weight_bps,value_cents)
         VALUES($1,$2,$3,$4) ON CONFLICT(portfolio_id,asset_class) DO UPDATE SET
         target_weight_bps=EXCLUDED.target_weight_bps,value_cents=EXCLUDED.value_cents`,
        [
          simulation.id,
          position.assetClass,
          position.targetWeightBps,
          position.valueCents,
        ],
      );
    }
    for (const item of simulation.transactions) {
      await this.pool.query(
        `INSERT INTO simulated_transactions(id,portfolio_id,type,asset_class,amount_cents,balance_after_cents,week,created_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(id) DO NOTHING`,
        [
          item.id,
          simulation.id,
          item.type,
          item.assetClass,
          item.amountCents,
          item.balanceAfterCents,
          item.week,
          item.createdAt,
        ],
      );
    }
    for (const event of simulation.rebalancingEvents) {
      await this.pool.query(
        `INSERT INTO rebalancing_events(id,portfolio_id,week,max_drift_bps,transaction_ids,created_at)
         VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(id) DO NOTHING`,
        [
          event.id,
          simulation.id,
          event.week,
          event.maxDriftBps,
          event.transactionIds,
          event.createdAt,
        ],
      );
    }
    for (const snapshot of simulation.weeklySnapshots) {
      await this.pool.query(
        `INSERT INTO weekly_snapshots(id,portfolio_id,week,value_cents,change_cents,protected_cash_cents,rebalanced,action_required,created_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(portfolio_id,week) DO NOTHING`,
        [
          snapshot.id,
          simulation.id,
          snapshot.week,
          snapshot.valueCents,
          snapshot.changeCents,
          snapshot.protectedCashCents,
          snapshot.rebalanced,
          snapshot.actionRequired,
          snapshot.createdAt,
        ],
      );
    }
  }
  async appendAudit(event: AuditEvent): Promise<void> {
    await this.pool.query(
      "INSERT INTO audit_events(id,user_id,type,original_message_id,payload,created_at) VALUES($1,$2,$3,$4,$5,$6)",
      [
        event.id,
        event.userId,
        event.type,
        event.originalMessageId ?? null,
        JSON.stringify(event.payload),
        event.createdAt,
      ],
    );
  }
  async listAudit(userId: string): Promise<AuditEvent[]> {
    const result = await this.pool.query<AuditEvent>(
      'SELECT id, user_id AS "userId", type, original_message_id AS "originalMessageId", payload, created_at AS "createdAt" FROM audit_events WHERE user_id=$1 ORDER BY created_at',
      [userId],
    );
    return result.rows;
  }
}

function rowToUser(row: {
  id: string;
  photon_user_id: string;
  photon_space_id: string;
  auth0_subject: string | null;
  verification_status: "unverified" | "verified" | "deleted";
  consent_version: string;
  mandate: Mandate;
}): UserRecord {
  const mandate = normalizeMandate(row.id, row.consent_version, row.mandate);
  return {
    id: row.id,
    photonUserId: row.photon_user_id,
    photonSpaceId: row.photon_space_id,
    ...(row.auth0_subject ? { auth0Subject: row.auth0_subject } : {}),
    verificationStatus: row.verification_status,
    consentVersion: row.consent_version,
    mandate,
  };
}

function normalizeMandate(
  userId: string,
  consentVersion: string,
  mandate: Partial<Mandate>,
): Mandate {
  const legacyRisk = mandate.riskPreference as string | undefined;
  const riskPreference =
    legacyRisk === "conservative"
      ? "low"
      : legacyRisk === "moderate"
        ? "medium"
        : legacyRisk === "aggressive"
          ? "high"
          : ["low", "medium", "high"].includes(legacyRisk ?? "")
            ? (legacyRisk as "low" | "medium" | "high")
            : "unknown";
  return {
    ...mandate,
    userId,
    expenses: Array.isArray(mandate.expenses) ? mandate.expenses : [],
    goals: Array.isArray(mandate.goals) ? mandate.goals : [],
    incomeChanges: Array.isArray(mandate.incomeChanges)
      ? mandate.incomeChanges
      : [],
    riskPreference,
    protectedCashCents: mandate.protectedCashCents ?? 0,
    recurringContributionCents: mandate.recurringContributionCents ?? 0,
    contributionsPaused: mandate.contributionsPaused ?? false,
    consentVersion: mandate.consentVersion ?? consentVersion,
    version: mandate.version ?? 1,
  };
}
