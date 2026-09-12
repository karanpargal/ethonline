# Privy developer feedback — from building AutoCFO (ETHOnline 2026)

Real findings from integrating `@privy-io/node` v0.34.0 with organization wallets,
policies, key quorums, and intents on Circle's Arc testnet, Sept 12–13 2026.

## What worked brilliantly

- **Policy evaluation on `eth_signTransaction`.** Even though Privy can't broadcast
  on Arc, policies still evaluate at signing time — so we sign via Privy and
  broadcast ourselves with viem, keeping the full TEE-enforced mandate. This
  "sign-only + self-broadcast" escape hatch made an unsupported chain fully usable.
- **Calldata conditions.** ABI-decoded conditions on `transfer.recipient` (`in`)
  and `transfer.amount` (`lte`) expressed our entire treasury mandate declaratively.
- **`generateP256KeyPair()` + per-call `authorization_context`** made the two-key
  design (bounded agent signer vs. owner quorum) trivial to implement.
- **`additional_signers` with `override_policy_ids` at wallet-create time** — being
  able to attach the bounded signer at creation avoided needing an owner signature
  for a follow-up update.

## Friction we hit (with repro details)

1. **Arc is not broadcastable.** `eth_sendTransaction` with `caip2: eip155:5042002`
   returns `401 App is not authorized to transact on chain eip155:5042002`.
   Privy is announced as an Arc wallet partner — enabling Tier-3 support (or a
   self-serve chain registry) would remove our workaround.
2. **Transfer intents don't support Arc.** `intents().transfer()` rejects every
   Arc slug; the error enumerates supported chains (ethereum, base + testnets,
   bsc, …). We wanted the propose→approve(MFA)→execute flow for over-mandate
   payments; we rebuilt it in-app using the owner key quorum instead. Intents on
   Arc would let us delete that code.
3. **SDK gaps vs. documented API** (v0.34.0): condition sets and aggregations
   (stateful policies) exist as *types* only — no client methods. We fell back to
   an inline `in` allowlist (policy redeploy per change) and dropped the rolling
   daily-budget rule. Docs pages describe both features; the SDK can't reach them.
4. **Rule `name` max 50 chars** — only discoverable via a 400 at create time.
5. **Local gas estimation ordering:** in sign-only mode, a payment exceeding the
   balance fails our local `estimateGas` before Privy ever sees it, so
   policy-denial vs. insufficient-funds classification had to be handled client-side.
6. **0.x semver trap:** `^0.5.0` in a tutorial pins you 29 minor versions behind
   (latest 0.34.0, where `organizations()` / `intents()` exist). A 1.0 release or
   louder deprecation notice would help.

## What we built on it

Organization wallet (treasury) owned by a human key quorum; AI agent as an
`additional_signer` bounded by a mandate policy (USDC-only, payee allowlist,
per-tx cap) evaluated in the TEE at signing; over-mandate payments queue for a
human whose approval executes with the owner quorum key the agent never holds.
