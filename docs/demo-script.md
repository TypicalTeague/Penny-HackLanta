# Penny judge demo

## Before the clock

- Replit Reserved VM, Spectrum stream, PostgreSQL, Gemini, and Auth0 are healthy.
- The demo phone is registered and the iMessage conversation is open.
- Database migrations are applied; `PENNY_UPDATE_DELAY_MS=10000` for the stage update.
- Keep the terminal and any browser UI out of the judged experience.

## 90-second script

**0:00 — Product:** “Tell Penny what is happening in your life, choose how much risk you are comfortable with, and Penny handles the investing work for you. Everything you’ll see is simulated and happens in iMessage.”

**0:08 — Onboarding:** Text: “I have $100 and I want you to handle investing it for me.” Show the tapback and typing indicator. Penny asks about near-term expenses.

**0:18 — Real life first:** Text: “I’ll need around $60 for textbooks in January.” Show `$60.00` protected, `$40.00` investable, and the native risk poll. Say: “Gemini extracted the facts. Deterministic rules did the money math.”

**0:30 — Risk and plan:** Tap **Medium risk**. Show the generated portfolio image with starting money, protected cash, paper portfolio, risk, and 60/30/10 allocation. Tap **Approve plan**.

**0:43 — Identity:** Open the Auth0-hosted verification link, verify, and return to Messages. Show the activation confirmation. Say: “The iMessage thread alone cannot authorize a consequential change; Auth0 binds the person to this exact proposal.”

**0:57 — Automated management:** Explain that Penny applies seeded, reproducible asset-class movements and rebalances only when drift exceeds five percentage points. The user never selects a stock or calculates diversification.

**1:07 — Proactive update:** Show “Good morning! Your weekly Penny update is ready 🌱”, its attached card, and the `$1.18` gain summary. Say: “This is a proactive Photon message, not a dashboard or a market API.”

**1:18 — Life changes:** Text: “My car broke down and repairs might cost $300.” Show the threaded response and native poll: Pause contributions / Explore withdrawing money / Keep my current plan. Tap an option and show that Auth0 verification is required before any change.

**1:28 — Close:** “Penny remembers your life, protects what you need, and manages the paper portfolio inside your approved mandate. No real money moved.”

## Recovery

- Photon delay: keep the iMessage thread on screen; retry delivery from the persisted space and snapshot.
- Gemini outage: show the safe clarification and confirm no financial-state change.
- Auth0 expiry: restart hosted verification; the proposal remains pending and unchanged.
- Demo state issue: use the verified reset action, never a direct database edit on stage.
- Market concern: emphasize that returns are seeded simulation data and reproduce the same judge run.
