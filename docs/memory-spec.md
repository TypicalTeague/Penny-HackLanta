# Penny memory specification

Penny stores only the facts required to continue the financial-safety conversation: available cash, active expenses, goals, risk preference, protected cash, plan state, verification binding, simulation state, a concise derived summary, and unresolved questions. Raw message text is neither stored nor logged.

## Identity

`photon_user_id = "photon_" + SHA-256(provider + ":" + Photon sender.id)` is the stable primary lookup. `photon_space_id` is retained only for routing. This prevents group-chat participants from sharing a financial profile. Auth0 `sub` is linked after successful device authorization and a different subject cannot mutate the profile.

## Message lifecycle

1. Claim the provider message ID in `message_receipts` and `message_events`.
2. Resolve the sender to one Penny user and load the complete context.
3. Pass a bounded, trusted context object and separately delimited untrusted message to Gemini.
4. Validate the structured interpretation with Zod.
5. In one database transaction, apply deterministic safety rules, upsert corrected facts, store plan/simulation changes, append an audit event, and refresh conversation memory.
6. Send the iMessage and mark the receipt completed. A repeated provider ID is ignored.

Expense labels are normalized for matching, so a correction updates the same record instead of adding a second current expense. All monetary values are integer cents.

## Privacy and retention

- “What do you remember?” and plan questions produce an answer from current stored facts.
- “Forget that expense” removes that expense and recalculates protected cash.
- “Forget me” deletes profile, mandate, expense, goal, memory, proposal, and simulation rows.
- Audit and message records may remain only for security/idempotency, with financial payload removed and user linkage cleared where supported.
- Secrets, raw message bodies, and Auth0 tokens are never persisted in these tables or application logs.

The hackathon prototype does not implement a time-based retention job. Production deployment requires a documented legal retention schedule and verified deletion workflow.
