# Penny Robo-Investor Technical Plan

## Existing-code assessment

The repository is TypeScript/Node 20 with Spectrum 12.2.0, Gemini, Auth0 device authorization, PostgreSQL and in-memory repositories, Zod, Vitest, and Replit-oriented scripts. Preserve identity resolution, message receipts, transaction wrappers, Auth0 challenge binding, strict Gemini parsing, audit minimization, and the terminal smoke transport. Replace the single-balance simulation and educational framing with a portfolio domain, native decision messages, richer persistence, and the judge flow.

## Architecture

`Spectrum inbound -> idempotency claim -> Photon user resolution -> load durable context -> deterministic shortcut or Gemini/Zod extraction -> safety engine -> proposal/portfolio engine -> transactional persistence -> native Spectrum response`

Weekly path: `scheduler -> due active users -> seeded market step -> drift/rebalance -> transactions + snapshot -> PNG card -> proactive Spectrum send`.

### Photon message architecture

The installed Spectrum 12.2.0 declarations confirm `space.responding()`, `message.react()`, `message.reply()`, `poll()`, `poll_option`, and `attachment()`. The transport maps application response parts (`text`, `poll`, `image`) to those builders, acknowledges actionable text with the iMessage `like` tapback, and treats inbound poll options as trusted only after matching a stored pending decision.

### Gemini structured-output contract

Gemini receives an untrusted user-message block plus minimized user context and returns one JSON object validated by Zod: intent, event type, label, amount, effective date/horizon, risk preference, selected option, confidence, and missing fields. The prompt explicitly prohibits calculations, trades, balances, returns, and instruction following from user content. Parse failure throws before the repository transaction mutates domain state.

### Identity and PostgreSQL

Hash `${platform}:${sender.id}` for a stable Photon identity; store the space ID for proactive sends; link it one-to-one to the verified Auth0 subject. Add portfolio, positions, transactions, rebalance events, weekly snapshots, income changes, typed proposal bodies, recurring contribution, and scheduler-delivery fields. Foreign keys cascade user deletion; audit/message records anonymize instead.

### Engines

- Capacity: pure functions over money, expenses, recurring context, and event input; return reason codes and proposals.
- Portfolio: configurable model allocation, exact-cent allocation, seeded per-asset weekly returns, drift calculation, threshold rebalance, contribution/withdrawal functions, and immutable transaction/snapshot results.
- Images: dependency-free SVG portfolio card rendered as a file attachment supported by iMessage. (PNG can be added through a renderer on Replit; SVG is included in Spectrum’s supported attachment family and keeps deploys deterministic.)

### Authorization

Use Auth0 OAuth 2.0 Device Authorization: Penny sends the hosted verification URI/code in iMessage, polls Auth0 without blocking the message loop, validates issuer/audience/signature, and binds completion to action/resource/user/expiry/version. Limitation: the user briefly leaves Messages for Auth0-hosted verification; there is no custom authentication site.

### Idempotency, privacy, and audit

Claim provider message IDs before parsing, release only on rollback-safe failure, and complete after response dispatch. Proposal keys derive from message IDs; weekly snapshot keys derive from user/week. Transactions are identified deterministically per logical operation. Logs contain hashed references and timing only. Audit payloads use amounts/reason codes but no raw conversational text.

### Replit deployment and scheduler

Build to `dist`, run one always-on Node process, expose `/healthz` only when configured, require `DATABASE_URL` outside local demo mode, and use a persisted weekly-snapshot uniqueness key so scheduler restarts are safe. Seeded returns remove market API dependency. Demo recovery uses fixed seed, a terminal smoke script, reset only after Auth0 verification, and prepared environment validation.

## Testing strategy

Unit-test safety, allocation, exact cents, drift boundaries, rebalancing, seeded returns, contribution and withdrawal. Integration-test the full judge conversation, malformed Gemini rollback, duplicate deliveries, verification rejection, two-user isolation, recall/deletion, and repository recreation using a shared durable test backing. Typecheck and production build are required gates.

## Features to remove or rewrite

Rewrite language that asks whether the user should consider investing, the single `Simulation` value, free-text approval flow, and education-first defaults. Preserve explanations only for user questions. No functioning Photon, Gemini, Auth0, persistence, or audit infrastructure is deleted.
