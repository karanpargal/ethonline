/**
 * ENSv2 setup, part 2 — resolver fix.
 *
 * PublicResolverV2 authorizes through the ENSv1 NameWrapper (migration compat),
 * so v2-native names can never set records on it. The v2-native pattern is a
 * PermissionedResolver proxy you own, with its OWN EAC roles per record type.
 *
 *   1. Deploy a PermissionedResolver proxy (admin = owner key)
 *   2. Point existing names (autocfo.eth in ETHRegistry, nimbushost in our
 *      UserRegistry) at it via setResolver
 *   3. Register the remaining payee subnames with it
 *   4. Set addr + autocfo.chain text records for all payees
 *   5. Grant the agent ENS key ROLE_SET_ADDR|ROLE_SET_TEXT on the resolver
 *      (so onboarding can write records) — bounded on the resolver side too
 *
 * Requires from part 1: ENS_USER_REGISTRY, ENS_AGENT_ADDRESS in .env.
 */
import "../src/env.js";
import { encodeFunctionData, parseAbi, type Address } from "viem";
import {
  ENS,
  FACTORY_ABI,
  REGISTRY_ABI,
  companyName,
  ensPublicClient,
  ensWallet,
  payeeNode,
} from "../src/ens.js";

const PERM_RESOLVER_ABI = parseAbi([
  "function initialize(address admin, uint256 roleBitmap, bytes[] setters)",
  "function setAddr(bytes32 node, address addr_)",
  "function setText(bytes32 node, string key, string value)",
  "function grantRootRoles(uint256 roleBitmap, address account)",
  "function addr(bytes32 node) view returns (address)",
]);
const REGISTRY_EXT_ABI = parseAbi([
  "function setResolver(uint256 anyId, address resolver)",
  "function findTokenId(string label) view returns (uint256)",
]);

// PermissionedResolverLib
const R_SET_ADDR = 1n << 0n;
const R_SET_TEXT = 1n << 4n;
const R_ADMIN = (r: bigint) => r << 128n;

const pub = ensPublicClient();
const owner = ensWallet("owner");

async function send(label: string, to: Address, data: `0x${string}`) {
  const hash = await owner.sendTransaction({ to, data });
  const receipt = await pub.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`${label} reverted: ${hash}`);
  console.log(`  ${label}: ${hash}`);
}

async function main() {
  const me = owner.account.address;
  const registry = process.env.ENS_USER_REGISTRY as Address;
  const agentEns = process.env.ENS_AGENT_ADDRESS as Address;
  if (!registry || !agentEns) throw new Error("run ens-setup part 1 first");
  const label = companyName();

  // 1. Deploy PermissionedResolver proxy
  const initData = encodeFunctionData({
    abi: PERM_RESOLVER_ABI,
    functionName: "initialize",
    args: [me, R_SET_ADDR | R_ADMIN(R_SET_ADDR) | R_SET_TEXT | R_ADMIN(R_SET_TEXT), []],
  });
  const salt = BigInt(Date.now());
  const { result: resolverAddr } = await pub.simulateContract({
    address: ENS.VerifiableFactory,
    abi: FACTORY_ABI,
    functionName: "deployProxy",
    args: [ENS.PermissionedResolverImpl, salt, initData],
    account: me,
  });
  await send(
    `deploy PermissionedResolver → ${resolverAddr}`,
    ENS.VerifiableFactory,
    encodeFunctionData({
      abi: FACTORY_ABI,
      functionName: "deployProxy",
      args: [ENS.PermissionedResolverImpl, salt, initData],
    }),
  );

  // 2. Point autocfo.eth (in ETHRegistry) at it
  const parentTokenId = await pub.readContract({
    address: ENS.ETHRegistry, abi: REGISTRY_EXT_ABI, functionName: "findTokenId", args: [label],
  });
  await send(`setResolver ${label}.eth`, ENS.ETHRegistry,
    encodeFunctionData({ abi: REGISTRY_EXT_ABI, functionName: "setResolver", args: [parentTokenId, resolverAddr] }));

  // 3. Payee subnames: fix nimbushost, register the rest
  const expiry = BigInt(Math.floor(Date.now() / 1000) + 365 * 86400);
  const payees: Array<[string, string, string]> = [
    ["nimbushost", process.env.SEED_PAYEE_1!, "arc-testnet"],
    ["marketfeed", process.env.SEED_PAYEE_2!, "arc-testnet"],
    ["dana", process.env.SEED_PAYEE_3!, "base-sepolia"],
  ];
  for (const [sub, addr, chain] of payees) {
    const existingOwner = await pub.readContract({
      address: registry, abi: REGISTRY_ABI, functionName: "findOwner", args: [sub],
    });
    if (existingOwner === "0x0000000000000000000000000000000000000000") {
      await send(`register ${sub}.${label}.eth`, registry,
        encodeFunctionData({
          abi: REGISTRY_ABI,
          functionName: "register",
          args: [sub, me, "0x0000000000000000000000000000000000000000", resolverAddr, 0n, expiry],
        }));
    } else {
      const tokenId = await pub.readContract({
        address: registry, abi: REGISTRY_EXT_ABI, functionName: "findTokenId", args: [sub],
      });
      await send(`setResolver ${sub}`, registry,
        encodeFunctionData({ abi: REGISTRY_EXT_ABI, functionName: "setResolver", args: [tokenId, resolverAddr] }));
    }
    const node = payeeNode(sub);
    await send(`  setAddr ${sub} → ${addr}`, resolverAddr,
      encodeFunctionData({ abi: PERM_RESOLVER_ABI, functionName: "setAddr", args: [node, addr as Address] }));
    await send(`  setText ${sub} autocfo.chain=${chain}`, resolverAddr,
      encodeFunctionData({ abi: PERM_RESOLVER_ABI, functionName: "setText", args: [node, "autocfo.chain", chain] }));
  }

  // 5. Agent may write records (but holds no admin roles on the resolver).
  //    Also (re-)grant registry roles — part 1's generated key was lost when
  //    the script aborted, so the .env key is a fresh one.
  await send(`grant SET_ADDR|SET_TEXT to agent ${agentEns}`, resolverAddr,
    encodeFunctionData({
      abi: PERM_RESOLVER_ABI,
      functionName: "grantRootRoles",
      args: [R_SET_ADDR | R_SET_TEXT, agentEns],
    }));
  const { ROLE_REGISTRAR, ROLE_RENEW } = await import("../src/ens.js");
  await send(`grant REGISTRAR|RENEW (registry) to agent ${agentEns}`, registry,
    encodeFunctionData({
      abi: REGISTRY_ABI,
      functionName: "grantRootRoles",
      args: [ROLE_REGISTRAR | ROLE_RENEW, agentEns],
    }));

  console.log(`
Part 2 complete. Add to .env:

ENS_RESOLVER=${resolverAddr}

Then: npx tsx scripts/ens-verify.ts`);
}

main().catch((e) => {
  console.error("ens-setup2 failed:", e instanceof Error ? e.message : e);
  process.exit(1);
});
