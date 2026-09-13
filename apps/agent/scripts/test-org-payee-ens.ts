// Proves 3-level payee names: onboard a payee inside a tenant org's own
// subregistry, then resolve <payee>.<org>.autocfo.eth via the Universal Resolver.
import "../src/env.js";
import { eq } from "drizzle-orm";
import { getDb, orgs } from "@autocfo/shared/db";
import { orgFromRow, runWithOrg } from "../src/org.js";
import { onboardPayeeOnEns } from "../src/ens-onboard.js";
import { resolvePayee } from "../src/ens.js";

async function main() {
  const row = getDb().select().from(orgs).where(eq(orgs.id, "job-test")).get();
  if (!row) throw new Error("job-test org not found in local DB");
  const ctx = orgFromRow(row);
  console.log(`org ${ctx.orgId} · registry ${ctx.ensRegistry}`);

  const result = await runWithOrg(ctx, () =>
    onboardPayeeOnEns("karan", "0xa69A06790Bc05b7a09cDDe04073b13A1E301F5dc", "arc-testnet"),
  );
  console.log(`registered: ${result.fullName} (${result.txHashes.length} txs)`);

  const { address, preferredChain } = await resolvePayee(result.fullName);
  console.log(`resolves → ${address} · chain=${preferredChain}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
