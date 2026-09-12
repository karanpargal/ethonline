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
