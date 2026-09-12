// Quick funding check for all demo accounts: treasury, petty cash, payees.
import "../src/env.js";
import { erc20Abi, formatUnits } from "viem";
import { getChainProfile } from "@autocfo/shared/chain";
import { publicClient } from "../src/privy.js";

const accounts: Array<[string, string | undefined]> = [
  ["treasury", process.env.PRIVY_TREASURY_ADDRESS],
  ["petty-cash", process.env.SEED_PAYEE_2 && process.env.PETTY_CASH_PRIVATE_KEY ? undefined : undefined],
  ["payee-1 (NimbusHost)", process.env.SEED_PAYEE_1],
  ["payee-2 (MarketFeed)", process.env.SEED_PAYEE_2],
  ["payee-3 (Dana)", process.env.SEED_PAYEE_3],
];

async function main() {
  const { usdc, chain } = getChainProfile();
  const c = publicClient();
  console.log(`chain: ${chain.name} (${chain.id}) · block ${await c.getBlockNumber()}`);

  const { privateKeyToAccount } = await import("viem/accounts");
  const pettyPk = process.env.PETTY_CASH_PRIVATE_KEY as `0x${string}` | undefined;
  if (pettyPk) accounts[1] = ["petty-cash", privateKeyToAccount(pettyPk).address];

  for (const [label, addr] of accounts) {
    if (!addr) continue;
    const bal = await c.readContract({
      address: usdc,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [addr as `0x${string}`],
    });
    console.log(`${label.padEnd(22)} ${addr}  ${formatUnits(bal, 6)} USDC`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
