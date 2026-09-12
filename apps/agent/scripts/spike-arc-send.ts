/**
 * THE Day-0 gate: can Privy move USDC on Arc testnet?
 *
 * Tries a 0.01 USDC transfer to SPIKE_RECIPIENT in both modes:
 *   1. broadcast   — Privy signs AND broadcasts (ideal)
 *   2. sign-local  — Privy signs, we broadcast via viem (fallback A)
 *
 * Prints which mode to set as PRIVY_SEND_MODE. If BOTH fail with chain-related
 * errors, fallback B applies: move the treasury lane to base-sepolia (CHAIN env).
 */
import "../src/env.js";
import { sendUsdcFromTreasury, publicClient } from "../src/privy.js";
import { explorerTxUrl, usdcToBaseUnits } from "@autocfo/shared";

const recipient = (process.env.SPIKE_RECIPIENT ??
  "0x000000000000000000000000000000000000dEaD") as `0x${string}`;
const amount = usdcToBaseUnits("0.01");

async function attempt(mode: "broadcast" | "sign-local") {
  process.env.PRIVY_SEND_MODE = mode;
  console.log(`\n--- Attempting mode: ${mode} ---`);
  try {
    const { hash } = await sendUsdcFromTreasury(recipient, amount);
    console.log(`Submitted: ${explorerTxUrl(hash)}`);
    const receipt = await publicClient().waitForTransactionReceipt({
      hash: hash as `0x${string}`,
      timeout: 30_000,
    });
    console.log(`✅ ${mode} works — status: ${receipt.status}`);
    console.log(`   Set PRIVY_SEND_MODE=${mode} in .env`);
    return true;
  } catch (err) {
    console.error(`❌ ${mode} failed:`, err instanceof Error ? err.message : err);
    return false;
  }
}

async function main() {
  if (await attempt("broadcast")) return;
  if (await attempt("sign-local")) return;
  console.error(`
Both modes failed. Decide fallback B: set CHAIN=base-sepolia for the treasury
lane (Privy Tier 3 documented) and keep x402/Gateway on Arc. Also check:
  - Is the treasury funded? (faucet.circle.com — needs USDC for gas too, it IS gas)
  - Is the agent registered as additional_signer with the mandate policy?
  - Does the policy have rules for BOTH eth_sendTransaction and eth_signTransaction?
`);
  process.exit(1);
}

main();
