# Penny Robo-Investor Product Specification

## Corrected problem statement and positioning

Beginners often want investing handled for them but cannot safely separate money needed for real life, construct a diversified portfolio, monitor drift, or adapt the plan after a life event. Penny is an iMessage-first robo-investing companion that protects near-term needs, creates and automatically manages a diversified paper portfolio, and asks the user only for facts, a risk preference, and approval of consequential changes.

Penny is not a course, quiz, stock picker, brokerage, or generic educational chatbot. Education is available on request to explain an action Penny already took or proposed.

## Target user

A beginner who has money they might invest, prefers Low/Medium/High choices over asset selection, uses iMessage, and wants their plan to respond to expenses, bonuses, raises, rent changes, tuition, and repairs without learning portfolio theory.

## Core user stories

- As a beginner, I can tell Penny how much simulated money I have and what I will need soon so essentials remain protected.
- I can select Low, Medium, or High risk in a native poll and receive a diversified paper portfolio without selecting assets.
- I can review a visual plan, verify with Auth0, and approve it in Messages.
- Penny can apply reproducible market movements and rebalance within my mandate without asking me to make routine decisions.
- I receive a proactive weekly iMessage with performance, allocation, reserve, and action-required status.
- I can report a life event conversationally and receive a safe adjustment proposal that is not enacted until I verify and approve it.
- I can ask what Penny remembers, remove an expense, or ask Penny to forget me.

## Judge-ready iMessage flow

1. User: “I have $100 and I want you to handle investing it for me.” Penny tapbacks to acknowledge, shows typing, records $100 simulated cash, and asks about near-term expenses.
2. User: “I’ll need around $60 for textbooks in January.” Gemini emits validated expense facts. Penny stores the expense, protects $60, computes $40 investable, then sends the “Choose your investing style” poll: Low risk / Medium risk / High risk.
3. User selects Medium. Penny stores the selection, creates a proposed $40 portfolio (60% diversified equities, 30% diversified bonds, 10% simulated cash equivalent), sends a generated portfolio-card image, then sends: Approve plan / Adjust it / Not yet.
4. User selects Approve plan. Penny starts Auth0 hosted device/passwordless verification. Only a verified callback bound to this user and proposal activates it.
5. Penny confirms the paper portfolio, records all initial transactions, and thereafter applies seeded market movement and rebalances when drift exceeds the configured threshold.
6. The scheduler proactively sends “Good morning! Your weekly Penny update is ready 🌱”, a portfolio image, and a concise summary of performance, protected cash, rebalancing, and required action.
7. User: “My car broke down and repairs might cost $300.” Penny replies in-thread, loads the existing mandate, stores the emergency expense, recalculates capacity, and offers: Pause contributions / Explore withdrawing money / Keep my current plan.
8. A chosen pause or withdrawal becomes a pending proposal. Auth0 verification plus explicit approval is required before the mandate or portfolio changes.

## Functional requirements

### Understanding and memory

- Resolve every inbound Spectrum message by hashed stable Photon sender identity and space identity.
- Load user, mandate, expenses, income changes, goals, portfolio, transactions, pending proposals, and concise memory before interpretation.
- Validate every Gemini response with Zod. On malformed or low-confidence output, ask for clarification and make no financial-state changes.
- Recognize cash introduction, expense, bonus, raise, rent increase, emergency expense, risk choice, poll choice, approval, withdrawal, pause/resume, memory recall, explanation, and deletion intents.

### Capacity and mandates

- Protect active essential expenses due within 90 days.
- Clamp protected cash to available cash; all monetary results are nonnegative integer cents.
- Recommend zero investment when needs consume available cash.
- A bonus may propose a contribution increase; a raise updates recurring-income context and may propose an increased recurring contribution.
- A rent increase or emergency expense may propose reducing/pausing contributions or exploring a simulated withdrawal.
- Risk choice cannot increase investable cash or override protected needs.
- All decisions return persisted reason codes.

### Portfolio management

- Model portfolios are configuration, not scattered constants: Low 20/60/20, Medium 60/30/10, High 85/10/5 across diversified equities, diversified bonds, and simulated cash equivalent.
- Allocate integer cents deterministically; residual cents go to the largest target so totals remain exact.
- Apply seeded weekly asset-class returns; identical seed, week, and portfolio produce identical results.
- Rebalance when any asset-class absolute drift is greater than 5 percentage points; no rebalance at or below the threshold.
- Record initial buys, contributions, withdrawals, market moves, and rebalance transactions, plus weekly snapshots and rebalance events.

### Identity and authorization

- Link a Photon user to one Auth0 subject after hosted verification.
- Require verification for first activation, risk changes, contribution increases, pause/resume, simulated withdrawals, and resets.
- Bind verification to user, action, resource, expiry, and current mandate version; stale or mismatched challenges fail closed.

### Native iMessage design

- Use Spectrum 12.2.0 `space.responding()` for best-effort typing and always let it clear in `finally` through the SDK helper.
- Use iMessage tapback `like` for immediate acknowledgment of actionable inbound text.
- Use `poll()` for the listed decisions and parse inbound `poll_option` messages.
- Use `message.reply()` for life-event responses and `attachment()` for generated PNG cards.
- Use proactive `space.send()` for weekly updates. Effects and contact sharing are optional and omitted unless the installed API supports them reliably.
- Never claim support for HTML cards or custom buttons.

## Nonfunctional requirements

- PostgreSQL state survives restarts and Replit deployments; in-memory storage is development/test only.
- Exactly-once effects are enforced by provider-message receipts and idempotency keys.
- All queries and records are user-scoped; no context can be shared across users.
- No raw messages, access tokens, Auth0 subjects, or full financial payloads appear in logs.
- Reproducible demo operation works without external market data and fails closed if Gemini or Auth0 is unavailable.
- Node.js 20+, TypeScript strict mode, and Replit always-on deployment are supported.

## Data model

- `penny_users`: Photon identity, space, Auth0 subject, verification status, consent version.
- `mandates`: cash, protected cash, recurring contribution, income context, risk, approval state/version.
- `expenses`, `income_changes`, `goals`: durable user facts.
- `proposals`: typed, version-bound changes with reason codes and status.
- `portfolios`, `portfolio_positions`: active paper portfolio and asset-class positions.
- `simulated_transactions`, `rebalancing_events`, `weekly_snapshots`: immutable operational history.
- `message_receipts`, `message_events`: idempotency and minimal processing metadata.
- `conversation_memory`: concise summary and unresolved questions.
- `audit_events`: security and decision trail with minimized payloads.

## Failure states

- Missing or ambiguous amount: clarify; no change.
- Malformed Gemini output: reject interpretation; no change.
- Duplicate Photon delivery: return no outbound duplicate and create no transaction.
- Stale/mismatched/expired verification: reject; no change.
- Database transaction failure: roll back and allow safe message retry.
- Card rendering failure: send the same structured summary as text; portfolio state remains valid.
- Photon send failure: retain state and audit delivery failure; scheduler may retry with the same update idempotency key.
- Scheduler restart: derive due updates from persisted snapshots, not timers alone.

## Sponsor-track mapping

- **Fintech:** deterministic capacity, mandates, diversified portfolios, rebalancing, transaction/audit history.
- **Photon Agents in iMessage:** Spectrum typing, tapbacks, threaded replies, polls, image attachments, and proactive updates.
- **Gemini API:** schema-constrained fact/intent extraction and optional explanations grounded in deterministic outputs.
- **Auth0:** hosted verification and authorization of consequential, proposal-bound actions.

## Regulatory and privacy boundaries

Every balance, return, allocation, and transaction is labeled simulated. Penny moves no money, accepts no deposit, connects to no brokerage, collects no banking credentials, and makes no guaranteed-return claim. The hackathon allocation models are demonstration configurations, not personalized investment recommendations. A production version would connect the mandate and portfolio-orchestration layers to licensed advisers, brokerages, and qualified custodians with the required disclosures and supervision.

“Forget me” deletes the profile, facts, mandate, portfolio, proposal, snapshot, and memory records; security/idempotency events are anonymized and retain no financial content under a documented minimal-retention policy.

## Acceptance criteria

- The complete $100 / $60 textbooks / Medium / $40 portfolio / approval / weekly update / $300 car repair journey works entirely in iMessage.
- All required safety, allocation, drift, life-event, malformed-model, duplicate-message, persistence, isolation, verification, recall, and deletion tests pass.
- README, architecture, demo script, Devpost copy, and GitHub description use the corrected positioning.

## Explicitly out of scope

Real money, deposits, live brokerage or bank connections, live market data, tax advice, order routing, arbitrary securities selection, a web dashboard, browser chat, React UI, lessons/quizzes/courses as a primary experience, and sponsor challenges unrelated to the product.
