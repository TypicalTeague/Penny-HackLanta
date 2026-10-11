# Penny three-minute judge demo

Penny is an iMessage-first automated-investing prototype using virtual money in Alpaca Broker API sandbox. It is not production-ready, licensed, or able to manage real customer money.

## Before the demo

```bash
npm ci
npm run check
npm run start:production
```

Required server-side secrets: Photon project ID/secret, Gemini API key, Auth0 domain/client/audience, PostgreSQL URL, Alpaca sandbox API key/secret, fictional sandbox account ID, and fictional sandbox ACH relationship ID. Keep `ALPACA_BROKER_BASE_URL=https://broker-api.sandbox.alpaca.markets`, `PENNY_BROKERAGE_PROVIDER=alpaca`, `PENNY_TRANSPORT=imessage`, and `PENNY_INTERPRETER=gemini`.

Confirm startup logs include all four `migration_applied` events and `spectrum_ready`. Optionally preflight the fictional account with `npm run alpaca:sandbox -- account`.

## Judge sequence

1. User: “I received $100, but I need $60 for textbooks. Invest the rest at medium risk.”
2. Penny: “Your $60 textbook money stays protected 💚 I can place the remaining $40 into your Medium plan: $24 diversified stocks, $12 bonds, and $4 cash. This is a simulated Alpaca sandbox portfolio for the demo. Reply CONFIRM 7K2P to continue.”
3. Explain: Gemini extracted facts; Zod validated them; deterministic code—not Gemini—computed `$100 - $60 = $40`, chose the configured model, and created the code.
4. User: `CONFIRM 7K2P` (use the actual code shown). Show that “yes” or a poll tap cannot authorize execution.
5. Complete the Auth0 hosted verification. Penny creates/retrieves the fictional sandbox account, requests virtual funding if required, and submits genuine Alpaca sandbox notional market/day orders for VTI and BND with deterministic client IDs.
6. Penny returns the simulated execution result through Photon. Ask “Did my order go through?” to show persisted sandbox order status.
7. Set `PENNY_UPDATE_DELAY_MS=10000` before startup or invoke the scheduler. Penny retrieves Alpaca sandbox account value and positions and sends the weekly Photon update.
8. User: “My car broke down and I need $300.”
9. Penny stores the essential life event, invalidates incompatible prior confirmation, deterministically reassesses the mandate, and proposes pausing, reducing risk, or a withdrawal. It does not liquidate or withdraw until a new proposal is confirmed and verified.

## What is real versus simulated

- Real: Photon/Spectrum message transport, Gemini structured extraction, Zod validation, deterministic safety/allocation, Auth0 verification, PostgreSQL records, and authenticated requests to Alpaca Broker API sandbox.
- Simulated: money, deposits, account holdings, fills, gains/losses, and the fictional demo identity inside Alpaca sandbox.
- Unavailable: real-money custody/funding/trading, production Alpaca endpoints, KYC through iMessage, a brokerage dashboard, tax/reporting workflows, and regulated advisory/compliance operations.

## Recovery

- Gemini/Photon/Alpaca failure: Penny sends a sanitized unavailable response and creates no extra order.
- Expired/wrong code or modified proposal: request a fresh proposal; no transfer or order occurs.
- Duplicate Photon delivery or confirmation: receipts/client IDs return the existing result.
- Sandbox reset: create a fresh fictional sandbox account or use Brokerdash; Penny intentionally does not fake a reset.
