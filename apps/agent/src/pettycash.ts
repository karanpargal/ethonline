import { GatewayClient } from "@circle-fin/x402-batching/client";
import { requiredEnv } from "./privy.js";

/**
 * The petty-cash lane: a small dedicated EOA whose key the agent service holds.
 * Capped exposure is the design point — the treasury (Privy, policy-guarded)
 * tops this wallet up in small amounts; this wallet funds gasless x402
 * micropayments through Circle Gateway.
 */
let _client: GatewayClient | null = null;

export function pettyCash(): GatewayClient {
  if (!_client) {
    _client = new GatewayClient({
      chain: "arcTestnet",
      privateKey: requiredEnv("PETTY_CASH_PRIVATE_KEY") as `0x${string}`,
    });
  }
  return _client;
}

export async function pettyCashState() {
  const client = pettyCash();
  const balances = await client.getBalances();
  return {
    address: client.address,
    balances,
  };
}
