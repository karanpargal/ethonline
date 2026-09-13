// Payee onboarding via the agent's BOUNDED ENS key (ROLE_REGISTRAR|ROLE_RENEW
// only). Registers <label>.<company>.eth in the company's UserRegistry and
// sets the payout address + preferred chain records.
import { encodeFunctionData, type Address } from "viem";
import {
  REGISTRY_ABI,
  RESOLVER_ABI,
  ensPublicClient,
  ensWallet,
  payeeFullName,
  payeeNode,
} from "./ens.js";
import { currentOrg } from "./org.js";

export async function onboardPayeeOnEns(
  label: string,
  payoutAddress: Address,
  preferredChain: string,
): Promise<{ fullName: string; txHashes: string[] }> {
  const org = currentOrg();
  // Each org has its own subregistry; the env org registers directly in the
  // company root registry. Records always live on our shared resolver.
  const registry = (org.ensRegistry ?? process.env.ENS_USER_REGISTRY) as Address | undefined;
  const resolver = process.env.ENS_RESOLVER as Address | undefined;
  if (!registry || !resolver)
    throw new Error("org has no ENS registry / ENS_RESOLVER not set");
  const wallet = ensWallet("agent");
  const pub = ensPublicClient();
  const owner = wallet.account.address;
  const expiry = BigInt(Math.floor(Date.now() / 1000) + 365 * 86400);
  const txHashes: string[] = [];

  const steps: Array<[Address, `0x${string}`]> = [
    [
      registry,
      encodeFunctionData({
        abi: REGISTRY_ABI,
        functionName: "register",
        args: [label, owner, "0x0000000000000000000000000000000000000000", resolver, 0n, expiry],
      }),
    ],
    [
      resolver,
      encodeFunctionData({ abi: RESOLVER_ABI, functionName: "setAddr", args: [payeeNode(label, org.ensLabel), payoutAddress] }),
    ],
    [
      resolver,
      encodeFunctionData({
        abi: RESOLVER_ABI,
        functionName: "setText",
        args: [payeeNode(label, org.ensLabel), "autocfo.chain", preferredChain],
      }),
    ],
  ];
  for (const [to, data] of steps) {
    const hash = await wallet.sendTransaction({ to, data });
    const receipt = await pub.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`onboard step reverted: ${hash}`);
    txHashes.push(hash);
  }
  return { fullName: payeeFullName(label, org.ensLabel), txHashes };
}
