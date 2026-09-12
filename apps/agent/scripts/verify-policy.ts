// Negative tests: the mandate must DENY over-cap and off-allowlist transfers.
// Run after spike-arc-send confirms the happy path.
import "../src/env.js";
import { sendUsdcFromTreasury } from "../src/privy.js";
import { usdcToBaseUnits } from "@autocfo/shared";

const ALLOWLISTED = process.env.SEED_PAYEE_1 as `0x${string}`;
const NOT_ALLOWLISTED = "0x000000000000000000000000000000000000dEaD" as const;

async function expectDenied(label: string, to: `0x${string}`, amount: string) {
  try {
    const { hash } = await sendUsdcFromTreasury(to, usdcToBaseUnits(amount));
    console.error(`❌ ${label}: was ALLOWED (tx ${hash}) — policy is broken!`);
    return false;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`✅ ${label}: denied as expected — ${msg.slice(0, 120)}`);
    return true;
  }
}

async function main() {
  const results = await Promise.all([
    expectDenied("over-cap ($60 > $50 cap) to allowlisted payee", ALLOWLISTED, "60"),
    expectDenied("off-allowlist recipient ($1)", NOT_ALLOWLISTED, "1"),
  ]);
  process.exit(results.every(Boolean) ? 0 : 1);
}

main();
