# Brokerage Integration Specification

## Purpose

Penny is an iMessage-first automated-investing prototype. Photon/Spectrum is the conversation surface, Gemini extracts structured facts, deterministic TypeScript protects essential funds and constructs model portfolios, Auth0 verifies consequential actions, PostgreSQL stores authoritative workflow state, and Alpaca Broker API sandbox represents the brokerage account and executes virtual-money orders.

Penny is not an investing-education chatbot, stock picker, brokerage dashboard, or production investment adviser. No conventional web application is introduced.

## Trust and authority boundaries

1. Photon transports messages, polls, replies, and updates. It never receives brokerage API credentials, bank credentials, tax identifiers, or onboarding documents.
2. Gemini may extract cash, protected expenses and dates, life events, risk, action type, and confirmation text. Its strict Zod output is untrusted until validated. It cannot calculate capacity, choose securities, confirm a proposal, or call a broker.
3. The deterministic engine alone computes protected and investable cents, resolves a configured risk model, creates exact-cent proposals, validates confirmation freshness, caps orders, and reassesses life events.
4. Auth0 verifies the person for consequential actions. Verification is bound to Penny user, proposal, mandate version, action, and expiry.
5. A provider-neutral `BrokerageService` is the only application boundary allowed to create/read sandbox accounts, fund, submit/cancel/read orders, read positions/value, or read activities.
6. PostgreSQL is authoritative for Penny workflow state. Alpaca remains authoritative for broker account, transfer, order, position, and account-value status; Penny stores identifiers and last-known snapshots.

## Required conversation behavior

Given “I received $100, but I need $60 for textbooks. Invest the rest at medium risk”:

1. Spectrum deduplicates the provider message and resolves a durable Penny user from the hashed sender identity.
2. Gemini returns only validated structured facts.
3. The safety engine protects $60 and computes a maximum investable amount of $40.
4. Deterministic configuration produces the Medium model: $24 VTI, $12 BND, and $4 retained as sandbox cash.
5. Penny persists and sends a proposal containing a unique ID/code, protected amount, investable amount, risk, allocation, expected orders, explanation, and expiry.
6. Penny enters `AWAITING_CONFIRMATION`. Only exact `CONFIRM <code>` for the same unexpired, unchanged proposal may continue. Poll selection or ordinary conversational assent is not approval.
7. Auth0 verifies the proposal-bound action when configured/required.
8. Penny rechecks proposal amount, mandate version, expiry, buying power, and order total, enters `SUBMITTING`, creates/retrieves the fictional sandbox account, requests virtual sandbox funding when required, and submits notional market/day ETF orders.
9. Penny persists account, transfer, order, status, and audit records and reports a clearly simulated result in iMessage.
10. Duplicate Photon messages or confirmations return the existing result and never fund or order twice.

For “My car broke down and I need $300,” Penny stores the life event, reruns deterministic safety, invalidates incompatible prior confirmation, and proposes pause, risk reduction, liquidation, or withdrawal without executing until a new proposal is confirmed and verified.

## Proposal state machine

`INTENT_RECEIVED -> PROPOSAL_CREATED -> AWAITING_CONFIRMATION -> VERIFIED -> SUBMITTING -> EXECUTED | PARTIALLY_FILLED | REJECTED | CANCELLED`

Every proposal contains:

- proposal ID and short confirmation code;
- user ID and mandate version;
- protected and maximum investable cents;
- approved risk level;
- deterministic allocation and expected notional orders;
- plain-language explanation and explicit sandbox label;
- creation and expiration timestamps;
- current state and an idempotency key.

Changing cash, protected expenses, risk, allocation, or mandate version invalidates the confirmation. Expired codes fail closed. Submitted/executed proposals are immutable except for broker status reconciliation.

## Deterministic model portfolios

The existing risk weights remain the source allocation policy and gain explicit ETF mapping:

| Risk   | VTI diversified stocks | BND bonds | Sandbox cash |
| ------ | ---------------------: | --------: | -----------: |
| Low    |                    20% |       60% |          20% |
| Medium |                    60% |       30% |          10% |
| High   |                    85% |       10% |           5% |

Cash creates no order. VTI and BND orders use notional dollars and must total no more than all of: deterministic investable amount, current buying power, and the amount confirmed by the user. Penny does not use options, margin, leverage, shorts, crypto, or individual speculative stocks.

## Brokerage abstraction

`BrokerageService` supports:

- create or retrieve a sandbox brokerage account;
- account status and buying power;
- sandbox virtual funding and transfer status;
- notional/fractional paper orders, order lookup, and eligible cancellation;
- positions, portfolio/account value, and account activities.

`AlpacaBrokerageAdapter` makes authenticated requests only to `https://broker-api.sandbox.alpaca.markets`. It rejects any production or non-HTTPS base URL both at construction and before every mutating call. It uses Basic authentication from server-only environment variables, sends deterministic `client_order_id` values, uses bounded timeouts, validates response shapes, and returns sanitized `BrokerageError` codes.

`FakeBrokerageAdapter` is allowed only when `PENNY_BROKERAGE_PROVIDER=fake` and `NODE_ENV` is not `production`; it exists for automated tests and explicitly labelled local development. There is no fallback from Alpaca to fake.

## Persistence and audit

Persist Penny user/Photon/Auth0 identity, Alpaca sandbox account ID/status, mandate and expenses, proposal state/code/expiry/allocation, confirmation timestamp, transfer IDs/status, order IDs/client IDs/status/notional, last positions/account snapshot, weekly-update timestamp, and append-only audit events.

Audit every proposal, confirmation attempt/result, verification, transfer request/status, order submission/status, weekly reconciliation, safety rejection, invalidation, and broker failure. Logs and audit payloads exclude credentials, raw tax/bank identity data, access tokens, and full raw messages.

## Photon templates

- Proposal: “Your $60 textbook money stays protected 💚 I can place the remaining $40 into your Medium plan: $24 diversified stocks, $12 bonds, and $4 cash. This is a simulated portfolio for the demo. Reply CONFIRM 7K2P to continue.”
- Confirmation required/expired or modified proposal.
- Auth0 verification required.
- Sandbox virtual deposit completed.
- Orders submitted/completed/rejected.
- Weekly simulated portfolio update from broker data.
- Life-event reassessment.
- Sanitized brokerage unavailable message with no claim that money moved.

## Hackathon sandbox behavior

- Only Alpaca’s US Broker API sandbox host is accepted; all money and fills are virtual.
- One clearly fictional demo account may be created from server-side `ALPACA_DEMO_ACCOUNT_APPLICATION_JSON`, or an existing sandbox account may be supplied with `ALPACA_DEMO_ACCOUNT_ID`.
- Sandbox funding uses the configured fictional ACH relationship through the sandbox transfer API. If unavailable, execution returns a clear configuration error; it never invents a successful deposit.
- Market prices/fills remain Alpaca sandbox behavior. Weekly updates use actual sandbox account/position responses.
- A development command may create/reset fictional sandbox state only when explicitly invoked.

## Simulated or unavailable integrations

- The test adapter is fully simulated and visibly labelled; it is never used implicitly.
- The existing seeded portfolio engine remains a deterministic presentation/test harness but is not brokerage truth when Alpaca mode is enabled.
- Account onboarding is either a pre-created fictional Alpaca sandbox account or an explicitly invoked sandbox account-creation command. Penny never collects KYC/PII through iMessage.
- No production bank transfer, custody, real-money order, tax reporting, market-data guarantee, or legal suitability workflow is implemented.

## Future regulated production deployment

A real deployment requires a licensed broker/custodian and likely registered-adviser structure or regulated partners; KYC/CIP and AML/sanctions controls; customer agreements and disclosures; suitability/fiduciary governance; best execution and order supervision; books-and-records retention; reconciliation; complaints, incident, privacy, and cybersecurity programs; tax reporting; business continuity; restricted-list and trading controls; jurisdiction-specific legal review; and human compliance/operations escalation. This prototype is not licensed or production-ready.

## Current implementation conflicts

1. README/specs and user messages say Penny never connects to a brokerage or executes trades.
2. `completeVerification` directly creates a seeded local `Simulation`; no broker boundary exists.
3. `approve_plan` starts Auth0 without an expiring proposal confirmation code.
4. `Proposal` lacks allocation, expected orders, expiry, confirmation, and execution states.
5. PostgreSQL has no brokerage accounts, transfers, orders, snapshots, or proposal-state columns.
6. Weekly updates advance seeded returns instead of retrieving broker positions/value.
7. `ask_order_status` always says no order was placed.
8. Environment validation has no provider selection, sandbox-host guard, Alpaca credentials, or fictional-account settings.
9. Audit is append-only but does not yet cover brokerage lifecycle events.
10. The existing in-memory repository is valid for tests/local development only and must not become the deployed financial-state store.

## Acceptance criteria

- The $100/$60/Medium flow creates a $40 expiring proposal and cannot execute before exact confirmation and verification.
- Order notionals never exceed protected-capacity, confirmed amount, or buying power.
- Duplicate deliveries/confirmations cannot duplicate transfers or orders.
- Invalid Gemini output cannot call the broker.
- A $300 life event deterministically reassesses before any liquidation/withdrawal.
- Weekly updates use brokerage data in Alpaca mode.
- Production Alpaca endpoints are rejected.
- External calls are mocked in the default test suite; an opt-in credentialed sandbox test exercises account, funding, order, and status APIs.
- Credentials do not appear in logs, audit payloads, generated attachments, or client-facing bundles.
