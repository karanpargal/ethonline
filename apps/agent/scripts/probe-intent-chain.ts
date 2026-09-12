// Probes which chain slug (if any) Privy transfer intents accept for Arc.
// Proposal-only — nothing executes without human quorum approval, and each
// created intent is immediately rejected to keep the dashboard clean.
import "../src/env.js";
import { getPrivy, requiredEnv } from "../src/privy.js";

const SLUGS = ["arc-testnet", "arc_testnet", "arcTestnet", "arc", "arc testnet"];

async function main() {
  const privy = getPrivy();
  const walletId = requiredEnv("PRIVY_TREASURY_WALLET_ID");
  const to = requiredEnv("SEED_PAYEE_2");
  for (const chain of SLUGS) {
    try {
      const intent = await privy.intents().transfer(walletId, {
        source: { asset: "usdc", chain },
        destination: { address: to },
        amount: "1",
      });
      console.log(`✅ "${chain}" ACCEPTED — intent ${intent.intent_id} (${intent.status})`);
      await privy.intents().reject(intent.intent_id);
      console.log(`   (rejected to keep things clean)`);
      return;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`❌ "${chain}": ${msg.slice(0, 140)}`);
    }
  }
  console.log("\nNo slug accepted — transfer intents do not support Arc.");
}

main();
