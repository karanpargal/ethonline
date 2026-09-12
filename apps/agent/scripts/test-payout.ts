// E2E test: cross-chain payout from the Arc Gateway balance to a recipient on Base Sepolia.
import "../src/env.js";
import { pettyCash } from "../src/pettycash.js";

async function main() {
  const client = pettyCash();
  const recipient = process.env.SEED_PAYEE_3 as `0x${string}`;
  console.log(`withdrawing 1 USDC → ${recipient} on baseSepolia…`);
  const result = await client.withdraw("1", { chain: "baseSepolia", recipient });
  console.log(
    JSON.stringify(result, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 1),
  );
}

main().catch((e) => {
  console.error("payout failed:", e instanceof Error ? e.message : e);
  process.exit(1);
});
