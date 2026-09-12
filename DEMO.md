# AutoCFO — self-service demo runbook

Everything runs locally against Arc testnet with real transactions. One tick
costs a few cents of OpenAI credits; everything else is free.

## 0. One-time prerequisites (already done on this machine)

- `.env` filled (Privy app, AI key, generated demo accounts)
- Treasury funded with Arc testnet USDC → https://faucet.circle.com
  (address: `PRIVY_TREASURY_ADDRESS` in .env; USDC is also gas on Arc)
- Petty cash funded on Arc + a little Base Sepolia ETH for cross-chain mints

## 1. Start everything

```bash
pnpm dev        # dashboard :3000 · agent API :3001 · x402 seller :3002
```

Open http://localhost:3000.

## 2. Reset to a clean ledger (before each take)

```bash
pnpm --filter @autocfo/agent demo:reset
```

Re-seeds 3 payees and 4 invoices: an overdue $5 hosting bill, its duplicate,
a $12 license renewal (over the $10 mandate cap), and a $2 contractor invoice
paid out cross-chain.

## 3. The demo beats (in order)

1. **Add your own invoice** — click **+ new invoice** in the Ledger header:
   pick a payee, amount, memo, and due date. Amount ≤ $10 to a vendor = the
   agent can pay it alone; amount > $10 = it must escalate. Pick "overdue" or
   "due today" so the agent acts on it this tick.
2. **Run the agent** — click **Run tick** (each click costs API credits).
   Watch the audit trail fill in: signal → decision → policy result → tx proof.
   - In-mandate invoices are paid on Arc instantly (explorer links appear).
   - The cross-chain contractor is paid via Circle Gateway on Base Sepolia.
   - The duplicate gets flagged, not paid.
   - The over-cap invoice flips to **awaiting approval**.
3. **Approve as the human owner** — click **approve** on the awaiting row.
   The payment executes signed by the *owner quorum key* — the key the agent
   never holds. This is the core pitch: the agent's autonomy is bounded by a
   Privy policy in a TEE, and exceptions require a different cryptographic key.
4. **Optional instruction** — type into the header box before Run tick, e.g.
   `buy a market brief` → the agent pays $0.001 over x402 from the petty-cash
   Gateway balance (gasless), or `top up petty cash with 2 USDC`.

## Video flow — the whole product without leaving the UI (~3 min)

Prep (off-camera): `pnpm --filter @autocfo/agent demo:reset`, both faucet
balances topped up, browser on http://localhost:3000, zoom ~110%.

**Scene 1 — The problem & the ledger (0:00–0:30).**
Start on the dashboard. Point at the balance strip: "This is AutoCFO — an AI
CFO holding a real company treasury in USDC on Arc. It's not a wallet with a
chatbot: the treasury is a Privy organization wallet, and the agent is a
bounded signer whose mandate — payee allowlist, $10 per-transaction cap — is
enforced by a policy engine inside a TEE, not by a prompt." Scroll the ledger:
four pending invoices, one visibly a duplicate, one over the cap.

**Scene 2 — A bill arrives (0:30–0:50).**
Click **+ new invoice**. Pick NimbusHost, amount **4**, memo "CDN overage",
due **today**, add. "An invoice just landed. Nobody has to wake up for this."

**Scene 3 — The agent works (0:50–1:50).**
Click **Run tick**. While it thinks, narrate the mandate footer. As results
land, walk the audit trail bottom-up:
- your $4 invoice + the $5 hosting bill: **paid on Arc** — click one
  **proof ↗** link, show the tx on Arcscan, come back.
- Dana Contractor: **paid cross-chain** — the treasury lives on Arc, Dana
  wants Base Sepolia; Circle Gateway minted it there in under a second.
- the duplicate invoice: **flagged**, not paid — same payee, same amount,
  same due date.
- the $12 license renewal: **awaiting approval** — over the $10 cap, so the
  agent physically cannot pay it; its key is rejected by the policy.
Read the agent memo card aloud — it explains its own reasoning.

**Scene 4 — Human in the loop (1:50–2:20).**
Point at the amber "awaiting approval · action required" stat. Click
**approve** on the row. "This signature comes from the owner quorum key —
a key the agent never holds. Autonomy inside the mandate, cryptography at the
boundary." Status flips to paid with its own proof link.

**Scene 5 — Agents buying data, x402 (2:20–2:50).**
Type `buy a market brief` in the header box, **Run tick**. Show the
x402 purchase in the trail: "$0.001, paid gaslessly over the x402 protocol
from a capped petty-cash balance in Circle Gateway — batched settlement, so
sub-cent payments actually work. The agent funds its own tools."

**Scene 6 — Close (2:50–3:10).**
Balance strip again: treasury down by exactly the paid invoices, every row in
the trail traces signal → decision → on-chain proof. "An autonomous CFO you
can audit line by line — and overrule with a better key."

## 4. Verify balances / funding state anytime

```bash
pnpm --filter @autocfo/agent exec tsx scripts/balances.ts
```

## 5. Troubleshooting

- **"insufficient funds" on pay** — treasury is low; refill at the faucet
  (20 USDC/day per address).
- **Cross-chain payout fails** — petty-cash address needs Base Sepolia ETH for
  the destination mint; a stranded mint can be replayed with
  `tsx scripts/replay-mint.ts` (update its calldata from the error output).
- **Policy denies something unexpected** — the allowlist/cap live in the Privy
  policy; update with `PER_TX_CAP_USDC=<n> tsx scripts/update-policy-cap.ts`.
- **Keep AI spend low** — steps and output are capped via `AGENT_MAX_STEPS`
  and `AGENT_MAX_OUTPUT_TOKENS` in .env; each tick is one click, never a loop.
