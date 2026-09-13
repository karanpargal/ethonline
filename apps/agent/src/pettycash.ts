import { GatewayClient } from "@circle-fin/x402-batching/client";
import { currentOrg } from "./org.js";

/**
 * The petty-cash lane: a small dedicated EOA per org whose key this service
 * custodies. Capped exposure is the design point — the treasury (Privy,
 * policy-guarded) tops this wallet up in small amounts; this wallet funds
 * gasless x402 micropayments through Circle Gateway.
 */
const clients = new Map<string, GatewayClient>();

export function pettyCash(): GatewayClient {
  const org = currentOrg();
  let client = clients.get(org.orgId);
  if (!client) {
    if (!org.pettyCashPk || org.pettyCashPk === "0x")
      throw new Error(`org ${org.orgId} has no petty-cash key`);
    client = new GatewayClient({ chain: "arcTestnet", privateKey: org.pettyCashPk });
    clients.set(org.orgId, client);
  }
  return client;
}

export async function pettyCashState() {
  const client = pettyCash();
  const balances = await client.getBalances();
  return { address: client.address, balances };
}
