/**
 * Day-0 setup: creates the Privy treasury environment.
 *
 *   1. Two P-256 authorization keypairs: the AGENT key (bounded signer) and the
 *      ADMIN key (backend ops key representing the human CFO's operational access)
 *   2. Agent key quorum (1-of-1) and owner key quorum (human dashboard user OR
 *      admin key, threshold 1 — humans approve intents in the dashboard, the
 *      admin key lets the backend do administrative updates programmatically)
 *   3. Organization + treasury wallet owned by the owner quorum, with the agent
 *      attached as additional_signer bounded by the mandate policy — set at
 *      CREATE time, since wallet updates require an owner authorization signature
 *   4. The mandate policy: USDC-only transfers, payee allowlist (inline `in`
 *      list for now — the SDK has no condition-set methods yet), per-tx cap
 *
 * NOT set up here (SDK v0.34 gaps — do in dashboard or REST if needed):
 *   - rolling 24h budget aggregation (stateful policies)
 *   - condition sets (mutable allowlist); allowlist changes = policy rule update
 *
 * Prints every id to paste into .env.
 */
import "../src/env.js";
import { PrivyClient, generateP256KeyPair } from "@privy-io/node";

type PolicyRule = Parameters<
  ReturnType<PrivyClient["policies"]>["create"]
>[0]["rules"][number];
import { getChainProfile, usdcToBaseUnits } from "@autocfo/shared";

const PER_TX_CAP_USDC = process.env.PER_TX_CAP_USDC ?? "50";

function requiredEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var ${name}`);
  return v;
}

// Payees allowed at setup time; extend later by updating the policy rule
// (authorized with the admin key).
const INITIAL_ALLOWLIST = (process.env.INITIAL_ALLOWLIST ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const TRANSFER_ABI = [
  {
    type: "function",
    name: "transfer",
    stateMutability: "nonpayable",
    inputs: [
      { internalType: "address", name: "recipient", type: "address" },
      { internalType: "uint256", name: "amount", type: "uint256" },
    ],
    outputs: [{ internalType: "bool", name: "", type: "bool" }],
  },
] as const;

async function main() {
  const privy = new PrivyClient({
    appId: requiredEnv("PRIVY_APP_ID"),
    appSecret: requiredEnv("PRIVY_APP_SECRET"),
  });
  const { usdc } = getChainProfile();

  // 1. Authorization keypairs (base64 SPKI public / base64 PKCS8 private)
  const agentKey = await generateP256KeyPair();
  const adminKey = await generateP256KeyPair();

  // 2. Key quorums
  const agentQuorum = await privy.keyQuorums().create({
    public_keys: [agentKey.publicKey],
    authorization_threshold: 1,
    display_name: "AutoCFO agent signer",
  });
  const ownerUserId = process.env.PRIVY_OWNER_USER_ID;
  const ownerQuorum = await privy.keyQuorums().create({
    public_keys: [adminKey.publicKey],
    ...(ownerUserId ? { user_ids: [ownerUserId] } : {}),
    authorization_threshold: 1,
    display_name: "AutoCFO human owners",
  });

  // 3. Organization
  const org = await privy.organizations().create({
    display_name: "AutoCFO Demo Inc",
    default_key_quorum_id: ownerQuorum.id,
  });

  // 4. The mandate policy (created before the wallet so it can be attached at create)
  if (INITIAL_ALLOWLIST.length === 0) {
    console.warn(
      "WARN: INITIAL_ALLOWLIST is empty — the agent won't be able to pay anyone. " +
        "Set INITIAL_ALLOWLIST=0xaddr1,0xaddr2 and re-run, or update the policy later.",
    );
  }
  const capHex = `0x${usdcToBaseUnits(PER_TX_CAP_USDC).toString(16)}`;
  const mandateRule = (
    method: "eth_sendTransaction" | "eth_signTransaction",
  ): PolicyRule => ({
    name: `Mandate: USDC ${method === "eth_sendTransaction" ? "send" : "sign"}`,
    method,
    action: "ALLOW" as const,
    conditions: [
      {
        field_source: "ethereum_transaction" as const,
        field: "to" as const,
        operator: "eq" as const,
        value: usdc,
      },
      {
        field_source: "ethereum_calldata" as const,
        field: "transfer.recipient",
        abi: TRANSFER_ABI,
        operator: "in" as const,
        value: INITIAL_ALLOWLIST,
      },
      {
        field_source: "ethereum_calldata" as const,
        field: "transfer.amount",
        abi: TRANSFER_ABI,
        operator: "lte" as const,
        value: capHex,
      },
    ],
  });
  const policy = await privy.policies().create({
    name: "AutoCFO mandate",
    version: "1.0",
    chain_type: "ethereum",
    owner_id: ownerQuorum.id,
    rules: [mandateRule("eth_sendTransaction"), mandateRule("eth_signTransaction")],
  });

  // 5. Treasury wallet: owned by humans, agent attached as bounded signer.
  const wallet = await privy.wallets().create({
    chain_type: "ethereum",
    display_name: "AutoCFO Treasury",
    entity: { id: org.id, type: "organization" },
    owner_id: ownerQuorum.id,
    additional_signers: [
      { signer_id: agentQuorum.id, override_policy_ids: [policy.id] },
    ],
  });

  console.log(`
Setup complete. Add to .env:

PRIVY_ORG_ID=${org.id}
PRIVY_TREASURY_WALLET_ID=${wallet.id}
PRIVY_TREASURY_ADDRESS=${wallet.address}
PRIVY_AGENT_QUORUM_ID=${agentQuorum.id}
PRIVY_OWNER_QUORUM_ID=${ownerQuorum.id}
PRIVY_POLICY_ID=${policy.id}
PRIVY_AGENT_AUTH_KEY=${agentKey.privateKey}
PRIVY_ADMIN_AUTH_KEY=${adminKey.privateKey}

Next steps:
  1. Fund ${wallet.address} with Arc testnet USDC: https://faucet.circle.com
  2. Run: pnpm --filter @autocfo/agent spike:arc-send
  3. (Dashboard) add the rolling 24h budget aggregation + link your dashboard
     user into the owner quorum for MFA intent approvals if not done above.
`);
}

main().catch((err) => {
  console.error("Setup failed:", err);
  process.exit(1);
});
