import { PrivyClient } from "@privy-io/node";
import { eq } from "drizzle-orm";
import { getDb, allowlist } from "@autocfo/shared/db";
import { getChainProfile } from "@autocfo/shared";
import { getPrivy } from "./privy.js";
import { currentOrg } from "./org.js";

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

/**
 * Regenerates the ENTIRE Privy mandate from the allowlist table: one ALLOW
 * rule per payee per method, each with that payee's own cap. Signed with the
 * ADMIN key — only call this after explicit human confirmation.
 */
export async function syncPolicyFromAllowlist(): Promise<{ rules: number }> {
  const org = currentOrg();
  const { usdc } = getChainProfile();
  const rows = getDb()
    .select()
    .from(allowlist)
    .where(eq(allowlist.orgId, org.orgId))
    .all();
  const rules: PolicyRule[] = [];
  for (const method of ["eth_sendTransaction", "eth_signTransaction"] as const) {
    for (const row of rows) {
      rules.push({
        // ≤50 chars (Privy limit)
        name: `${row.label.slice(0, 30)} ${method === "eth_sendTransaction" ? "send" : "sign"}`,
        method,
        action: "ALLOW",
        conditions: [
          { field_source: "ethereum_transaction", field: "to", operator: "eq", value: usdc },
          {
            field_source: "ethereum_calldata",
            field: "transfer.recipient",
            abi: TRANSFER_ABI,
            operator: "eq",
            value: row.address,
          },
          {
            field_source: "ethereum_calldata",
            field: "transfer.amount",
            abi: TRANSFER_ABI,
            operator: "lte",
            value: `0x${BigInt(row.capBaseUnits).toString(16)}`,
          },
        ],
      });
    }
  }
  await getPrivy()
    .policies()
    .update(org.policyId, {
      rules,
      authorization_context: {
        authorization_private_keys: [org.adminAuthKey],
      },
    });
  return { rules: rules.length };
}
