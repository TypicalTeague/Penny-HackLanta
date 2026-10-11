# Penny Robo-Investor Constitution

## Purpose

Penny removes the portfolio-management burden from beginners through an iMessage-first, paper-only robo-investing experience. Education supports transparency but never replaces automated portfolio management.

## Governing principles

1. **Protect life before investing.** Near-term essential needs are reserved first. Investable cash is never greater than available cash less protected cash and may be zero.
2. **Conversation in, deterministic decisions out.** Gemini extracts intent and facts into a strict schema. Ordinary TypeScript rules calculate financial capacity, construct portfolios, move the simulation, and rebalance it.
3. **One approved mandate, routine automation.** The user chooses Low, Medium, or High risk and approves a mandate. Penny may rebalance inside that mandate; risk, contribution, withdrawal, pause/resume, and reset changes require explicit approval and Auth0 verification.
4. **iMessage is the product.** The judged journey occurs in Messages through Photon Spectrum. Conversation bubbles gather context, native polls capture decisions, and generated image attachments present portfolio information. There is no product dashboard.
5. **Paper means paper.** Penny accepts no deposits, collects no bank or brokerage credentials, places no real orders, and labels balances, returns, and transactions as simulated. It never guarantees returns.
6. **Durable, isolated memory.** PostgreSQL is the source of truth. Photon identity resolves each message to one Penny user, later linked to an Auth0 subject. Records are scoped by user, survive restarts, and support deletion/anonymization.
7. **Auditable and recoverable.** Consequential decisions include reason codes, transactions are append-only, inbound messages are idempotent, simulation data is seeded, and the demo does not depend on a market-data API.
8. **Least data and least authority.** Logs exclude message bodies, credentials, and financial detail. User text is untrusted input and cannot override system rules.

## Delivery gates

Every material change must preserve schema validation, deterministic tests, user isolation, idempotency, verification boundaries, and the paper-trading boundary. A change is complete only after type checking, automated tests, a production build, documentation updates, and a judge-flow smoke check.
