// Updates the mandate policy's per-tx cap (owner-authorized with the admin key).
// Usage: PER_TX_CAP_USDC=10 npx tsx scripts/update-policy-cap.ts
import "../src/env.js";
import { PrivyClient } from "@privy-io/node";
import { getChainProfile, usdcToBaseUnits } from "@autocfo/shared";

type PolicyRule = Parameters<
  ReturnType<PrivyClient["policies"]>["create"]
>[0]["rules"][number];

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

function requiredEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var ${name}`);
  return v;
}

async function main() {
  const privy = new PrivyClient({
    appId: requiredEnv("PRIVY_APP_ID"),
    appSecret: requiredEnv("PRIVY_APP_SECRET"),
  });
  const { usdc } = getChainProfile();
  const cap = process.env.PER_TX_CAP_USDC ?? "10";
  const capHex = `0x${usdcToBaseUnits(cap).toString(16)}`;
  const allowlist = (process.env.INITIAL_ALLOWLIST ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const rule = (method: "eth_sendTransaction" | "eth_signTransaction"): PolicyRule => ({
    name: `Mandate: USDC ${method === "eth_sendTransaction" ? "send" : "sign"}`,
    method,
    action: "ALLOW",
    conditions: [
      { field_source: "ethereum_transaction", field: "to", operator: "eq", value: usdc },
      {
        field_source: "ethereum_calldata",
        field: "transfer.recipient",
        abi: TRANSFER_ABI,
        operator: "in",
        value: allowlist,
      },
      {
        field_source: "ethereum_calldata",
        field: "transfer.amount",
        abi: TRANSFER_ABI,
        operator: "lte",
        value: capHex,
      },
    ],
  });

  const updated = await privy.policies().update(requiredEnv("PRIVY_POLICY_ID"), {
    rules: [rule("eth_sendTransaction"), rule("eth_signTransaction")],
    authorization_context: {
      authorization_private_keys: [requiredEnv("PRIVY_ADMIN_AUTH_KEY")],
    },
  });
  console.log(`policy ${updated.id} updated: cap $${cap}, allowlist ${allowlist.length} addresses`);
}

main().catch((e) => {
  console.error("update failed:", e);
  process.exit(1);
});
