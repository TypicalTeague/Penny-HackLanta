import type {
  AuditEvent,
  ConversationMemory,
  Mandate,
  Proposal,
  Simulation,
  UserRecord,
  UserContext,
} from "../domain/types.js";

export interface PennyRepository {
  transaction<T>(
    operation: (repository: PennyRepository) => Promise<T>,
  ): Promise<T>;
  claimMessage(messageId: string): Promise<boolean>;
  attachMessageToUser(messageId: string, userId: string): Promise<void>;
  recordMessageIntent(messageId: string, intent: string): Promise<void>;
  completeMessage(messageId: string): Promise<void>;
  releaseMessage(messageId: string): Promise<void>;
  getOrCreateUser(
    photonUserId: string,
    photonSpaceId: string,
    consentVersion: string,
    legacySenderKey?: string,
  ): Promise<UserRecord>;
  getUser(userId: string): Promise<UserRecord | undefined>;
  listUsersWithActivePortfolios(): Promise<UserRecord[]>;
  getUserContext(userId: string): Promise<UserContext | undefined>;
  saveMandate(mandate: Mandate): Promise<void>;
  saveConversationMemory(memory: ConversationMemory): Promise<void>;
  deleteUserData(userId: string): Promise<void>;
  linkAuth0Subject(userId: string, subject: string): Promise<void>;
  createProposal(proposal: Proposal): Promise<Proposal>;
  getProposal(id: string): Promise<Proposal | undefined>;
  saveProposal(proposal: Proposal): Promise<void>;
  getSimulationByUser(userId: string): Promise<Simulation | undefined>;
  saveSimulation(simulation: Simulation): Promise<void>;
  appendAudit(event: AuditEvent): Promise<void>;
  listAudit(userId: string): Promise<AuditEvent[]>;
}
