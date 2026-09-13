// Verifies ENSv2 state end-to-end: resolution through the Universal Resolver
// (no hard-coded values — this is the judges' requirement) + the agent's role.
import "../src/env.js";
import {
  ENS,
  REGISTRY_ABI,
  ROLE_REGISTRAR,
  ROLE_RENEW,
  ROLE_SET_SUBREGISTRY,
  companyName,
  ensPublicClient,
  resolvePayee,
} from "../src/ens.js";

async function main() {
  const label = companyName();
  const registry = process.env.ENS_USER_REGISTRY as `0x${string}`;
  const agent = process.env.ENS_AGENT_ADDRESS as `0x${string}`;
  const pub = ensPublicClient();

  for (const sub of ["nimbushost", "marketfeed", "dana"]) {
    const full = `${sub}.${label}.eth`;
    const { address, preferredChain } = await resolvePayee(full);
    console.log(
      `${full.padEnd(28)} → ${address ?? "UNRESOLVED ❌"}  chain=${preferredChain ?? "-"}`,
    );
  }

  if (registry && agent) {
    const [canRegister, canAdmin] = await Promise.all([
      pub.readContract({
        address: registry, abi: REGISTRY_ABI, functionName: "hasRootRoles",
        args: [ROLE_REGISTRAR | ROLE_RENEW, agent],
      }),
      pub.readContract({
        address: registry, abi: REGISTRY_ABI, functionName: "hasRootRoles",
        args: [ROLE_SET_SUBREGISTRY, agent],
      }),
    ]);
    console.log(`\nagent ${agent}`);
    console.log(`  ROLE_REGISTRAR|ROLE_RENEW: ${canRegister ? "granted ✅" : "missing ❌"}`);
    console.log(`  ROLE_SET_SUBREGISTRY:      ${canAdmin ? "GRANTED (too much!) ❌" : "not granted ✅ (properly bounded)"}`);
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
