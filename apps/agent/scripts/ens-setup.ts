/**
 * One-time ENSv2 Sepolia setup for AutoCFO (needs Sepolia ETH on the owner key):
 *
 *   1. Mint MockUSDC + approve the ETHRegistrar (ENSv2 charges stablecoins)
 *   2. Deploy the company's UserRegistry proxy via VerifiableFactory
 *   3. Register {ENS_COMPANY_LABEL}.eth (commit → wait 60s → register),
 *      wired to the UserRegistry as its subregistry
 *   4. Generate the agent's ENS key; grant it ONLY ROLE_REGISTRAR|ROLE_RENEW
 *      on the payee registry (Enhanced Access Control — the agent can onboard
 *      payees but cannot touch the parent name)
 *   5. Register the three seed payees as subnames + set addr/text records
 *
 * Prints env additions when done. Idempotent-ish: skips registration if the
 * name is already taken by us.
 */
import "../src/env.js";
import { randomBytes } from "node:crypto";
import { encodeFunctionData, toHex, type Address } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  ADMIN,
  ENS,
  FACTORY_ABI,
  MOCK_USDC_ABI,
  REGISTRAR_ABI,
  REGISTRY_ABI,
  RESOLVER_ABI,
  ROLE_REGISTRAR,
  ROLE_RENEW,
  ROLE_SET_RESOLVER,
  ROLE_SET_SUBREGISTRY,
  companyName,
  ensPublicClient,
  ensWallet,
  payeeNode,
} from "../src/ens.js";

const pub = ensPublicClient();
const owner = ensWallet("owner");

async function send(label: string, tx: { to: Address; data: `0x${string}` }) {
  const hash = await owner.sendTransaction(tx);
  const receipt = await pub.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`${label} reverted: ${hash}`);
  console.log(`  ${label}: ${hash}`);
  return receipt;
}

async function main() {
  const me = owner.account.address;
  const label = companyName();
  console.log(`owner ${me} · registering "${label}.eth"`);

  // -- 1. MockUSDC funds
  const usdcBal = await pub.readContract({
    address: ENS.MockUSDC, abi: MOCK_USDC_ABI, functionName: "balanceOf", args: [me],
  });
  if (usdcBal < 10_000_000n) {
    await send("mint 10 MockUSDC", {
      to: ENS.MockUSDC,
      data: encodeFunctionData({ abi: MOCK_USDC_ABI, functionName: "mint", args: [me, 10_000_000n] }),
    });
  }
  await send("approve registrar", {
    to: ENS.MockUSDC,
    data: encodeFunctionData({ abi: MOCK_USDC_ABI, functionName: "approve", args: [ENS.ETHRegistrar, 10_000_000n] }),
  });

  // -- 2. Deploy the company UserRegistry proxy
  const ALL_NEEDED =
    ROLE_REGISTRAR | ADMIN(ROLE_REGISTRAR) |
    ROLE_RENEW | ADMIN(ROLE_RENEW) |
    ROLE_SET_SUBREGISTRY | ADMIN(ROLE_SET_SUBREGISTRY) |
    ROLE_SET_RESOLVER | ADMIN(ROLE_SET_RESOLVER);
  const initData = encodeFunctionData({
    abi: REGISTRY_ABI,
    functionName: "initialize",
    args: [me, ALL_NEEDED],
  });
  const salt = BigInt(Date.now());
  const { result: registryAddr } = await pub.simulateContract({
    address: ENS.VerifiableFactory,
    abi: FACTORY_ABI,
    functionName: "deployProxy",
    args: [ENS.UserRegistryImpl, salt, initData],
    account: me,
  });
  await send(`deploy UserRegistry proxy → ${registryAddr}`, {
    to: ENS.VerifiableFactory,
    data: encodeFunctionData({ abi: FACTORY_ABI, functionName: "deployProxy", args: [ENS.UserRegistryImpl, salt, initData] }),
  });

  // -- 3. Register the .eth name (commit-reveal)
  const available = await pub.readContract({
    address: ENS.ETHRegistrar, abi: REGISTRAR_ABI, functionName: "isAvailable", args: [label],
  });
  if (!available) throw new Error(`"${label}.eth" is taken — set ENS_COMPANY_LABEL to something else`);
  const duration = await pub.readContract({
    address: ENS.ETHRegistrar, abi: REGISTRAR_ABI, functionName: "MIN_REGISTER_DURATION",
  });
  const secret = toHex(randomBytes(32), { size: 32 });
  const commitment = await pub.readContract({
    address: ENS.ETHRegistrar,
    abi: REGISTRAR_ABI,
    functionName: "makeCommitment",
    args: [label, me, secret, registryAddr, ENS.PublicResolverV2, duration, `0x${"0".repeat(64)}`],
  });
  await send("commit", {
    to: ENS.ETHRegistrar,
    data: encodeFunctionData({ abi: REGISTRAR_ABI, functionName: "commit", args: [commitment] }),
  });
  const minAge = await pub.readContract({
    address: ENS.ETHRegistrar, abi: REGISTRAR_ABI, functionName: "MIN_COMMITMENT_AGE",
  });
  const waitSec = Number(minAge) + 5;
  console.log(`  waiting ${waitSec}s for commitment to mature…`);
  await new Promise((r) => setTimeout(r, waitSec * 1000));
  await send(`register ${label}.eth`, {
    to: ENS.ETHRegistrar,
    data: encodeFunctionData({
      abi: REGISTRAR_ABI,
      functionName: "register",
      args: [label, me, secret, registryAddr, ENS.PublicResolverV2, duration, ENS.MockUSDC, `0x${"0".repeat(64)}`],
    }),
  });

  // -- 4. Agent ENS key with a bounded role
  const agentPk = generatePrivateKey();
  const agentAddr = privateKeyToAccount(agentPk).address;
  await send(`grant REGISTRAR|RENEW to agent ${agentAddr}`, {
    to: registryAddr,
    data: encodeFunctionData({
      abi: REGISTRY_ABI,
      functionName: "grantRootRoles",
      args: [ROLE_REGISTRAR | ROLE_RENEW, agentAddr],
    }),
  });

  // -- 5. Seed payees as subnames with records
  const expiry = BigInt(Math.floor(Date.now() / 1000) + 365 * 86400);
  const payees: Array<[string, string, string]> = [
    ["nimbushost", process.env.SEED_PAYEE_1!, "arc-testnet"],
    ["marketfeed", process.env.SEED_PAYEE_2!, "arc-testnet"],
    ["dana", process.env.SEED_PAYEE_3!, "base-sepolia"],
  ];
  for (const [sub, addr, chain] of payees) {
    await send(`register ${sub}.${label}.eth`, {
      to: registryAddr,
      data: encodeFunctionData({
        abi: REGISTRY_ABI,
        functionName: "register",
        args: [sub, me, "0x0000000000000000000000000000000000000000", ENS.PublicResolverV2, ROLE_SET_RESOLVER, expiry],
      }),
    });
    const node = payeeNode(sub);
    await send(`  setAddr ${sub}`, {
      to: ENS.PublicResolverV2,
      data: encodeFunctionData({ abi: RESOLVER_ABI, functionName: "setAddr", args: [node, addr as Address] }),
    });
    await send(`  setText ${sub} autocfo.chain=${chain}`, {
      to: ENS.PublicResolverV2,
      data: encodeFunctionData({ abi: RESOLVER_ABI, functionName: "setText", args: [node, "autocfo.chain", chain] }),
    });
  }

  console.log(`
ENS setup complete. Add to .env:

ENS_COMPANY_LABEL=${label}
ENS_USER_REGISTRY=${registryAddr}
ENS_AGENT_PRIVATE_KEY=${agentPk}
ENS_AGENT_ADDRESS=${agentAddr}

Verify: npx tsx scripts/ens-verify.ts
`);
}

main().catch((e) => {
  console.error("ens-setup failed:", e instanceof Error ? e.message : e);
  process.exit(1);
});
