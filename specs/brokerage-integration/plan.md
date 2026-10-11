# Brokerage Integration Technical Plan

## Existing system to preserve

- Node 20, TypeScript ESM/strict, npm lockfile, Prettier, Vitest, and `tsc` build.
- Spectrum 12.2 async message stream, sender hashing, message receipts, tapbacks, replies, polls, attachments, and proactive sends.
- Gemini structured JSON plus Zod, deterministic safety/portfolio functions, Auth0 device authorization, PostgreSQL transactions/user locking, minimized logs, and in-memory tests.
- No browser product surface; `/healthz` remains operational only.

## Implementation slices

1. Extend domain types with brokerage records, deterministic security allocations, expected orders, proposal states/code/expiry, and broker snapshots.
2. Add a provider-neutral brokerage interface, strict errors, sandbox URL guard, Alpaca HTTP adapter, and test-only fake adapter.
3. Extend repository contracts and both implementations. Add idempotent PostgreSQL migration `004_brokerage_integration.sql` for broker accounts, transfers, orders, snapshots, confirmation/execution fields, and weekly timestamps.
4. Extend config/bootstrap with explicit provider selection. `alpaca` requires sandbox credentials and fictional account/application configuration; `fake` is rejected in production; `none` keeps non-execution diagnostics explicit.
5. Add deterministic proposal construction, confirmation-code parsing, expiry/version validation, order caps, brokerage execution, reconciliation, safe errors, and audit events to `PennyService`.
6. Route weekly updates to brokerage positions/value when an Alpaca/Fake broker account exists; retain seeded simulation only as an explicit legacy/local presentation path.
7. Add an opt-in sandbox smoke command and keep all external network boundaries injectable/mockable.
8. Update tests, README, architecture documentation, and `DEMO.md`.

## Alpaca HTTP mapping

- Create account: `POST /v1/accounts`; retrieve: `GET /v1/accounts/{account_id}`.
- Trading account/buying power: `GET /v1/trading/accounts/{account_id}/account`.
- Sandbox funding: `POST /v1/accounts/{account_id}/transfers`; transfer: `GET /v1/accounts/{account_id}/transfers/{transfer_id}`.
- Order submit/list/get/cancel: `/v1/trading/accounts/{account_id}/orders` and `/{order_id}`.
- Positions: `GET /v1/trading/accounts/{account_id}/positions`.
- Activities: `GET /v1/accounts/activities` filtered by account ID.

All writes use the same guarded sandbox origin, a timeout, Basic auth, JSON, deterministic client IDs where supported, and response validation.

## Compatibility strategy

Do not replace working conversation, safety, identity, or persistence code wholesale. Add the broker as a dependency with a default explicit `UnavailableBrokerageAdapter` for existing tests/diagnostics. Preserve old records through normalization defaults and idempotent migration. Update activation at the narrow verified-proposal boundary.

## Verification gates

For each slice: targeted unit tests, then typecheck. Completion gate: formatting, full Vitest suite, build, terminal smoke, and opt-in Alpaca sandbox integration test only when credentials exist. No task is checked until its corresponding verification passes.
