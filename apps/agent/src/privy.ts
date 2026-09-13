import { PrivyClient } from "@privy-io/node";
import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  erc20Abi,
  http,
  parseGwei,
} from "viem";
import {
  ARC_MIN_BASE_FEE_GWEI,
  getChainProfile,
} from "@autocfo/shared/chain";
import { currentOrg } from "./org.js";

let _privy: PrivyClient | null = null;

export function getPrivy(): PrivyClient {
  if (!_privy) {
    _privy = new PrivyClient({
      appId: requiredEnv("PRIVY_APP_ID"),
      appSecret: requiredEnv("PRIVY_APP_SECRET"),
    });
  }
  return _privy;
}

export function requiredEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var ${name}`);
  return v;
}

export const publicClient = () => {
  const { chain } = getChainProfile();
  return createPublicClient({ chain, transport: http() });
};

// P-256 authorization keys (base64 PKCS8, from setup-privy.ts), passed per-call —
// the SDK computes the privy-authorization-signature header.
// - agent: the bounded signer; every request is checked against the mandate policy.
// - owner: the human/admin quorum key; NOT policy-bounded. Used only by the
//   explicit human-approval endpoint, never by the agent's tools.
export type Signer = "agent" | "owner";

function authContext(signer: Signer) {
  const org = currentOrg();
  const key = signer === "owner" ? org.adminAuthKey : org.agentAuthKey;
  if (!key) throw new Error(`no ${signer} auth key for org ${org.orgId}`);
  return { authorization_private_keys: [key] };
}

export interface SendResult {
  hash: string;
  mode: "privy-broadcast" | "sign-local";
}

/**
 * Pay `baseUnits` of USDC (6-dec ERC-20) from the Privy treasury wallet to `to`.
 *
 * Privy's policy engine evaluates this request inside the TEE before signing —
 * a policy denial surfaces as a Privy API error, distinct from an on-chain revert
 * (simulation runs BEFORE policy evaluation, so reverts also pre-empt policy).
 *
 * PRIVY_SEND_MODE=broadcast   → Privy signs AND broadcasts (needs Arc support on their side)
 * PRIVY_SEND_MODE=sign-local  → Privy signs (policies still apply), we broadcast via viem (fallback A)
 */
export async function sendUsdcFromTreasury(
  to: `0x${string}`,
  baseUnits: bigint,
  signer: Signer = "agent",
): Promise<SendResult> {
  const privy = getPrivy();
  const walletId = currentOrg().walletId;
  if (!walletId) throw new Error("org has no treasury wallet");
  const { chain, usdc, caip2 } = getChainProfile();
  const data = encodeFunctionData({
    abi: erc20Abi,
    functionName: "transfer",
    args: [to, baseUnits],
  });
  const mode = process.env.PRIVY_SEND_MODE ?? "broadcast";

  if (mode === "broadcast") {
    const { hash } = await privy.wallets().ethereum().sendTransaction(walletId, {
      caip2,
      params: {
        transaction: {
          to: usdc,
          data,
          value: "0x0",
          chain_id: chain.id,
          max_fee_per_gas: `0x${parseGwei(String(ARC_MIN_BASE_FEE_GWEI * 2n)).toString(16)}`,
          max_priority_fee_per_gas: "0x0",
        },
      },
      authorization_context: authContext(signer),
    });
    return { hash, mode: "privy-broadcast" };
  }

  // Fallback A: Privy signs (policy-checked), we broadcast against Arc RPC ourselves.
  const pub = publicClient();
  const treasury = currentOrg().treasuryAddress;
  const nonce = await pub.getTransactionCount({ address: treasury });
  const gas = await pub.estimateGas({
    account: treasury,
    to: usdc,
    data,
  });
  const signed = await privy.wallets().ethereum().signTransaction(walletId, {
    params: {
      transaction: {
        to: usdc,
        data,
        value: "0x0",
        chain_id: chain.id,
        nonce,
        gas_limit: `0x${gas.toString(16)}`,
        max_fee_per_gas: `0x${parseGwei(String(ARC_MIN_BASE_FEE_GWEI * 2n)).toString(16)}`,
        max_priority_fee_per_gas: "0x0",
        type: 2,
      },
    },
    authorization_context: authContext(signer),
  });
  const hash = await pub.sendRawTransaction({
    serializedTransaction: signed.signed_transaction as `0x${string}`,
  });
  return { hash, mode: "sign-local" };
}

// NOTE: Privy transfer intents do NOT support Arc (verified 2026-09-13; the API
// enumerates its supported chains and Arc is absent). The escalation flow instead
// queues over-mandate payments in-app; a human approval executes them with the
// owner quorum key via sendUsdcFromTreasury(to, amount, "owner").

/** Classify a failed Privy send so the agent can react correctly. */
export function classifyPrivyError(
  err: unknown,
): "policy_denied" | "insufficient_funds" | "simulation_failed" | "unknown" {
  const msg = err instanceof Error ? err.message.toLowerCase() : String(err).toLowerCase();
  if (msg.includes("policy")) return "policy_denied";
  if (msg.includes("exceeds balance") || msg.includes("insufficient funds"))
    return "insufficient_funds";
  if (msg.includes("simulat") || msg.includes("revert")) return "simulation_failed";
  return "unknown";
}
