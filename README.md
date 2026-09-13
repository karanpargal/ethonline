# AutoCFO

**An autonomous CFO agent with a policy-guarded treasury on Arc.** Built for ETHOnline 2026.

AutoCFO runs a company's money the way a real finance team would: the AI agent pays vendor
invoices in USDC when they're due, but only inside a mandate that is **enforced by Privy's
policy engine in a TEE — not by the prompt**. Anything outside the mandate (over-threshold,
off-allowlist) is escalated as a Privy intent that a human approves with MFA. Every
disbursement traces to a concrete signal in an auditable activity trail.

## Prize tracks

- **Privy — Best B2B Financial Product**: organization wallet + policies + key quorums + intents (all four controls, load-bearing)
- **Privy — Best Financial Flow**: cross-chain contractor payout via Circle Gateway
- **Arc — Best Agentic Economy Application**: agent treasury on Arc, x402 nanopayments via Circle Gateway

## Architecture

```
apps/web        Next.js dashboard — invoices, audit trail, approvals, agent controls
apps/agent      Agent service — Vercel AI SDK loop (Anthropic/OpenAI swappable) + Hono API
packages/shared Chain config (Arc testnet), SQLite schema (Drizzle), USDC helpers
```

Two-lane money design:

1. **Treasury lane (Privy):** org wallet on Arc; the agent is an `additional_signer` bounded
   by one override policy — payee allowlist (condition set), per-tx calldata cap, rolling
   24h budget. Policy denial → the agent proposes a transfer intent → human MFA approval
   in the Privy dashboard → auto-execution.
2. **Petty-cash lane (Circle):** a small dedicated EOA deposited into Circle Gateway pays
   x402-metered APIs via nanopayments; the treasury tops it up under policy.

## Setup

```bash
pnpm install
cp .env.example .env       # fill in Privy + AI keys
pnpm --filter @autocfo/agent setup:privy      # creates org, wallet, policy, quorums
# fund the treasury address: https://faucet.circle.com (Arc testnet USDC)
pnpm --filter @autocfo/agent spike:arc-send   # verifies Privy can move USDC on Arc
pnpm --filter @autocfo/agent seed             # demo payees + invoices
pnpm dev                                      # web on :3000, agent on :3001
```

## Multi-tenant onboarding

Anyone can spin up an AutoCFO org from the app: `POST /orgs {name, email}` (or
the web onboarding screen) provisions in ~1 minute:

- a Privy **organization wallet** with a TEE-enforced mandate policy and the
  agent attached as a bounded signer (we custody both authorization keys)
- a dedicated **petty-cash EOA** for gasless x402 micropayments via Gateway
- an **ENSv2 identity**: `<org>.autocfo.eth` with its own subregistry, so
  payees become `<payee>.<org>.autocfo.eth` (registered by the agent's
  role-bounded ENS key). The org name resolves to its treasury.

Access is a bearer token (shown once). The AI runs on the platform's API key.

## Deploy

**Agent API** (Fly.io): see `fly.toml` — Docker build from
`apps/agent/Dockerfile`, a 1GB volume at `/data` for SQLite, secrets per the
comment block. Railway/Render work the same way (set `DATABASE_PATH` to the
volume, `PORT` is respected). `ALLOW_ENV_ORG=false` in production makes every
request require an org token.

**Dashboard** (Vercel): project root `apps/web`, env
`NEXT_PUBLIC_AGENT_API=https://<your-agent-host>`.

## Status

Multi-tenant, live on Arc testnet + ENSv2 Sepolia. See DEMO.md for the demo
runbook and video script.
