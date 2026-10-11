import { randomUUID } from "node:crypto";
import type {
  AuditEvent,
  BrokerageAccountRecord,
  BrokerageOrderRecord,
  BrokerageSnapshot,
  BrokerageTransferRecord,
  ConversationMemory,
  Mandate,
  Proposal,
  Simulation,
  UserRecord,
  UserContext,
} from "../domain/types.js";
import type { PennyRepository } from "./repository.js";

export class InMemoryRepository implements PennyRepository {
  private readonly receipts = new Map<string, "processing" | "completed">();
  private readonly messageUsers = new Map<string, string>();
  private readonly messageIntents = new Map<string, string>();
  private readonly users = new Map<string, UserRecord>();
  private readonly senderIndex = new Map<string, string>();
  private readonly proposals = new Map<string, Proposal>();
  private readonly proposalKeys = new Map<string, string>();
  private readonly simulations = new Map<string, Simulation>();
  private readonly audit: AuditEvent[] = [];
  private readonly memories = new Map<string, ConversationMemory>();
  private readonly brokerageAccounts = new Map<
    string,
    BrokerageAccountRecord
  >();
  private readonly brokerageTransfers = new Map<
    string,
    BrokerageTransferRecord
  >();
  private readonly brokerageTransferKeys = new Map<string, string>();
  private readonly brokerageOrders = new Map<string, BrokerageOrderRecord>();
  private readonly brokerageOrderKeys = new Map<string, string>();
  private readonly brokerageSnapshots = new Map<string, BrokerageSnapshot>();

  async transaction<T>(
    operation: (repository: PennyRepository) => Promise<T>,
  ): Promise<T> {
    const snapshot = this.snapshot();
    try {
      return await operation(this);
    } catch (error) {
      this.restore(snapshot);
      throw error;
    }
  }

  async lockUser(_userId: string): Promise<void> {
    // JavaScript execution is single-process in diagnostic mode. PostgreSQL
    // supplies the cross-worker lock used by production.
  }

  async claimMessage(messageId: string): Promise<boolean> {
    if (this.receipts.has(messageId)) return false;
    this.receipts.set(messageId, "processing");
    return true;
  }
  async completeMessage(messageId: string): Promise<void> {
    this.receipts.set(messageId, "completed");
  }
  async releaseMessage(messageId: string): Promise<void> {
    if (this.receipts.get(messageId) === "processing")
      this.receipts.delete(messageId);
  }
  async attachMessageToUser(messageId: string, userId: string): Promise<void> {
    this.messageUsers.set(messageId, userId);
  }
  async recordMessageIntent(messageId: string, intent: string): Promise<void> {
    this.messageIntents.set(messageId, intent);
  }

  async getOrCreateUser(
    photonUserId: string,
    photonSpaceId: string,
    consentVersion: string,
    _legacySenderKey?: string,
  ): Promise<UserRecord> {
    const known = this.senderIndex.get(photonUserId);
    if (known) {
      const user = this.users.get(known)!;
      user.photonSpaceId = photonSpaceId;
      return structuredClone(user);
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
    const user: UserRecord = {
      id,
      photonUserId,
      photonSpaceId,
      verificationStatus: "unverified",
      consentVersion,
      mandate,
    };
    this.users.set(id, structuredClone(user));
    this.senderIndex.set(photonUserId, id);
    return structuredClone(user);
  }
  async getUser(userId: string): Promise<UserRecord | undefined> {
    const value = this.users.get(userId);
    return value ? structuredClone(value) : undefined;
  }
  async listUsersWithActivePortfolios(): Promise<UserRecord[]> {
    return [...this.users.values()]
      .filter((user) => this.simulations.get(user.id)?.status === "active")
      .map((user) => structuredClone(user));
  }
  async getUserContext(userId: string): Promise<UserContext | undefined> {
    const user = await this.getUser(userId);
    if (!user) return undefined;
    const pendingProposal = user.mandate.pendingProposalId
      ? await this.getProposal(user.mandate.pendingProposalId)
      : undefined;
    const simulation = await this.getSimulationByUser(userId);
    return {
      user,
      mandate: user.mandate,
      ...(this.memories.has(userId)
        ? { memory: structuredClone(this.memories.get(userId)!) }
        : {}),
      ...(pendingProposal ? { pendingProposal } : {}),
      ...(simulation ? { simulation } : {}),
    };
  }
  async saveMandate(mandate: Mandate): Promise<void> {
    const user = this.users.get(mandate.userId);
    if (!user) throw new Error("Unknown user");
    user.mandate = structuredClone(mandate);
  }
  async saveConversationMemory(memory: ConversationMemory): Promise<void> {
    this.memories.set(memory.userId, structuredClone(memory));
  }
  async linkAuth0Subject(userId: string, subject: string): Promise<void> {
    const user = this.users.get(userId);
    if (!user) throw new Error("Unknown user");
    user.auth0Subject = subject;
    user.verificationStatus = "verified";
  }
  async deleteUserData(userId: string): Promise<void> {
    const user = this.users.get(userId);
    if (!user) return;
    this.senderIndex.delete(user.photonUserId);
    this.users.delete(userId);
    this.memories.delete(userId);
    this.simulations.delete(userId);
    this.brokerageAccounts.delete(userId);
    this.brokerageSnapshots.delete(userId);
    for (const [id, transfer] of this.brokerageTransfers)
      if (transfer.userId === userId) {
        this.brokerageTransfers.delete(id);
        this.brokerageTransferKeys.delete(transfer.idempotencyKey);
      }
    for (const [id, order] of this.brokerageOrders)
      if (order.userId === userId) {
        this.brokerageOrders.delete(id);
        this.brokerageOrderKeys.delete(order.clientOrderId);
      }
    for (const [id, proposal] of this.proposals)
      if (proposal.userId === userId) {
        this.proposals.delete(id);
        this.proposalKeys.delete(proposal.idempotencyKey);
      }
    for (let index = this.audit.length - 1; index >= 0; index -= 1)
      if (this.audit[index]?.userId === userId)
        this.audit[index] = {
          ...this.audit[index]!,
          payload: { retainedFor: "security_and_idempotency" },
        };
  }
  async createProposal(proposal: Proposal): Promise<Proposal> {
    const existingId = this.proposalKeys.get(proposal.idempotencyKey);
    if (existingId) return structuredClone(this.proposals.get(existingId)!);
    this.proposals.set(proposal.id, structuredClone(proposal));
    this.proposalKeys.set(proposal.idempotencyKey, proposal.id);
    return structuredClone(proposal);
  }
  async getProposal(id: string): Promise<Proposal | undefined> {
    const value = this.proposals.get(id);
    return value ? structuredClone(value) : undefined;
  }
  async saveProposal(proposal: Proposal): Promise<void> {
    this.proposals.set(proposal.id, structuredClone(proposal));
  }
  async getSimulationByUser(userId: string): Promise<Simulation | undefined> {
    const value = this.simulations.get(userId);
    return value ? structuredClone(value) : undefined;
  }
  async saveSimulation(simulation: Simulation): Promise<void> {
    this.simulations.set(simulation.userId, structuredClone(simulation));
  }
  async getBrokerageAccount(
    userId: string,
  ): Promise<BrokerageAccountRecord | undefined> {
    const value = this.brokerageAccounts.get(userId);
    return value ? structuredClone(value) : undefined;
  }
  async saveBrokerageAccount(account: BrokerageAccountRecord): Promise<void> {
    this.brokerageAccounts.set(account.userId, structuredClone(account));
  }
  async getBrokerageTransferByKey(
    idempotencyKey: string,
  ): Promise<BrokerageTransferRecord | undefined> {
    const id = this.brokerageTransferKeys.get(idempotencyKey);
    const value = id ? this.brokerageTransfers.get(id) : undefined;
    return value ? structuredClone(value) : undefined;
  }
  async saveBrokerageTransfer(
    transfer: BrokerageTransferRecord,
  ): Promise<void> {
    this.brokerageTransfers.set(transfer.id, structuredClone(transfer));
    this.brokerageTransferKeys.set(transfer.idempotencyKey, transfer.id);
  }
  async listBrokerageOrders(
    proposalId: string,
  ): Promise<BrokerageOrderRecord[]> {
    return structuredClone(
      [...this.brokerageOrders.values()].filter(
        (order) => order.proposalId === proposalId,
      ),
    );
  }
  async saveBrokerageOrder(order: BrokerageOrderRecord): Promise<void> {
    const existingId = this.brokerageOrderKeys.get(order.clientOrderId);
    if (existingId && existingId !== order.id) return;
    this.brokerageOrders.set(order.id, structuredClone(order));
    this.brokerageOrderKeys.set(order.clientOrderId, order.id);
  }
  async getBrokerageSnapshot(
    userId: string,
  ): Promise<BrokerageSnapshot | undefined> {
    const value = this.brokerageSnapshots.get(userId);
    return value ? structuredClone(value) : undefined;
  }
  async saveBrokerageSnapshot(snapshot: BrokerageSnapshot): Promise<void> {
    this.brokerageSnapshots.set(snapshot.userId, structuredClone(snapshot));
  }
  async appendAudit(event: AuditEvent): Promise<void> {
    this.audit.push(structuredClone(event));
  }
  async listAudit(userId: string): Promise<AuditEvent[]> {
    return structuredClone(
      this.audit.filter((event) => event.userId === userId),
    );
  }

  private snapshot() {
    return structuredClone({
      receipts: [...this.receipts],
      messageUsers: [...this.messageUsers],
      messageIntents: [...this.messageIntents],
      users: [...this.users],
      senderIndex: [...this.senderIndex],
      proposals: [...this.proposals],
      proposalKeys: [...this.proposalKeys],
      simulations: [...this.simulations],
      audit: this.audit,
      memories: [...this.memories],
      brokerageAccounts: [...this.brokerageAccounts],
      brokerageTransfers: [...this.brokerageTransfers],
      brokerageTransferKeys: [...this.brokerageTransferKeys],
      brokerageOrders: [...this.brokerageOrders],
      brokerageOrderKeys: [...this.brokerageOrderKeys],
      brokerageSnapshots: [...this.brokerageSnapshots],
    });
  }

  private restore(snapshot: ReturnType<InMemoryRepository["snapshot"]>) {
    restoreMap(this.receipts, snapshot.receipts);
    restoreMap(this.messageUsers, snapshot.messageUsers);
    restoreMap(this.messageIntents, snapshot.messageIntents);
    restoreMap(this.users, snapshot.users);
    restoreMap(this.senderIndex, snapshot.senderIndex);
    restoreMap(this.proposals, snapshot.proposals);
    restoreMap(this.proposalKeys, snapshot.proposalKeys);
    restoreMap(this.simulations, snapshot.simulations);
    restoreMap(this.memories, snapshot.memories);
    restoreMap(this.brokerageAccounts, snapshot.brokerageAccounts);
    restoreMap(this.brokerageTransfers, snapshot.brokerageTransfers);
    restoreMap(this.brokerageTransferKeys, snapshot.brokerageTransferKeys);
    restoreMap(this.brokerageOrders, snapshot.brokerageOrders);
    restoreMap(this.brokerageOrderKeys, snapshot.brokerageOrderKeys);
    restoreMap(this.brokerageSnapshots, snapshot.brokerageSnapshots);
    this.audit.splice(0, this.audit.length, ...snapshot.audit);
  }
}

function restoreMap<K, V>(map: Map<K, V>, entries: [K, V][]): void {
  map.clear();
  for (const [key, value] of entries) map.set(key, value);
}
