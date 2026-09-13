// Regenerates the Privy mandate policy from the allowlist table (admin key).
import "../src/env.js";
import { getDb, allowlist } from "@autocfo/shared/db";
import { baseUnitsToUsdc } from "@autocfo/shared";
import { syncPolicyFromAllowlist } from "../src/policy.js";

async function main() {
  const rows = getDb().select().from(allowlist).all();
  for (const r of rows)
    console.log(`${r.label.padEnd(22)} ${r.address}  cap $${baseUnitsToUsdc(BigInt(r.capBaseUnits))}`);
  const { rules } = await syncPolicyFromAllowlist();
  console.log(`policy resynced: ${rules} rules`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
