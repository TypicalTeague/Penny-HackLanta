# Brokerage Integration Tasks

## 1. Inspection and specification

- [x] Inventory architecture, package manager, database/migrations, tests, environment handling, Spectrum transport, Gemini, Auth0, persistence, scheduler, and deployment.
- [x] Document sandbox behavior, simulated/unavailable behavior, regulated-production requirements, conflicts, acceptance criteria, and technical plan.

## 2. Domain and brokerage boundary

- [x] Add proposal lifecycle, confirmation, deterministic allocation/order, brokerage account/transfer/order/position/activity/snapshot types.
- [x] Add provider-neutral `BrokerageService` and sanitized typed errors.
- [x] Implement guarded `AlpacaBrokerageAdapter` with genuine sandbox requests.
- [x] Implement explicit test/local-only `FakeBrokerageAdapter` without fallback.

## 3. Persistence and configuration

- [x] Extend repository contract, in-memory repository, and PostgreSQL repository.
- [x] Add idempotent brokerage migration and migration runner entry.
- [x] Add server-only environment variables, provider construction, and production/sandbox guards.
- [x] Add fictional sandbox account create/reset development command.

## 4. Conversation and execution

- [x] Create expiring deterministic proposals with confirmation codes and friendly Photon copy.
- [x] Require exact confirmation of the same unmodified proposal before Auth0 and execution.
- [x] Recheck capacity, mandate version, buying power, and approved amount before submitting.
- [x] Execute idempotent virtual funding and notional ETF orders and persist every reference/status.
- [x] Return safe Photon success/failure/order-status messages.
- [x] Reassess life events and invalidate stale confirmation before any withdrawal/liquidation.
- [x] Use brokerage positions/value for weekly updates.

## 5. Tests

- [x] Protected/negative capacity, approval caps, no-confirmation, expiry, modification, duplicate delivery, duplicate confirmation, invalid Gemini, life event, weekly broker data, Alpaca failure, production URL, and credential-leak tests pass.
- [x] Alpaca adapter request/response tests mock every network boundary.
- [x] Optional credentialed sandbox account/funding/order/status test is separately invoked and skipped by default.

## 6. Documentation and final verification

- [x] Update README and architecture documentation.
- [x] Create `DEMO.md` with exact three-minute commands and conversation.
- [x] Run format check, typecheck, all tests, build, and smoke.
- [x] Record final files, genuine/simulated behavior, credentials/setup, commands, results, and blockers.
