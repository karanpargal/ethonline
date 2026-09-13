// Sends a little Sepolia ETH from the owner key to the agent's ENS key (gas
// for onboarding transactions).
import "../src/env.js";
import { parseEther, formatEther } from "viem";
import { ensPublicClient, ensWallet } from "../src/ens.js";

async function main() {
  const owner = ensWallet("owner");
  const to = process.env.ENS_AGENT_ADDRESS as `0x${string}`;
  const hash = await owner.sendTransaction({ to, value: parseEther("0.015") });
  await ensPublicClient().waitForTransactionReceipt({ hash });
  const bal = await ensPublicClient().getBalance({ address: to });
  console.log(`funded ${to}: ${formatEther(bal)} ETH (${hash})`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
