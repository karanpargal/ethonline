// Self-serve org provisioning. One call creates a complete, custodied AutoCFO
// tenant: Privy org + quorums + treasury wallet + mandate policy, a petty-cash
// EOA, and an ENSv2 subname with its own subregistry (<slug>.autocfo.eth) so
// the org's payees become <payee>.<slug>.autocfo.eth. AutoCFO custodies all
// keys and the ENS name; the AI runs on our API key. ENS is best-effort — a
// Sepolia hiccup must not block treasury creation.
import { eq } from "drizzle-orm";
import { PrivyClient, generateP256KeyPair } from "@privy-io/node";
import { encodeFunctionData, type Address } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { getDb, orgs } from "@autocfo/shared/db";
import {
  ADMIN,
  ENS,
  FACTORY_ABI,
  REGISTRY_ABI,
  ROLE_REGISTRAR,
  ROLE_RENEW,
  ROLE_SET_RESOLVER,
  ROLE_SET_SUBREGISTRY,
  companyName,
  ensPublicClient,
  ensWallet,
} from "./ens.js";
import { getPrivy, requiredEnv } from "./privy.js";
import { hashToken, newToken } from "./org.js";

export interface OnboardResult {
  orgId: string;
  token: string; // shown ONCE — we store only the hash
  treasuryAddress: string;
  pettyCashAddress: string;
  ensName: string | null;
}

function sanitizeCap(v: string | undefined, fallback: string): string {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 && n <= 1_000_000 ? String(n) : fallback;
}

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24);
}

export async function onboardOrg(
  name: string,
  email: string,
  caps?: { perTxCapUsdc?: string; dailyCapUsdc?: string },
): Promise<OnboardResult> {
  const db = getDb();
  let slug = slugify(name);
  if (!slug) throw new Error("org name must contain letters or numbers");
  // Keep slugs unique.
  let n = 1;
  while (db.select().from(orgs).where(eq(orgs.id, slug)).get())
    slug = `${slugify(name)}-${++n}`;

  const privy: PrivyClient = getPrivy();

  // 1. Keys + quorums (custodied)
  const adminKey = await generateP256KeyPair();
  const agentKey = await generateP256KeyPair();
  const agentQuorum = await privy.keyQuorums().create({
    public_keys: [agentKey.publicKey],
    authorization_threshold: 1,
    display_name: `${slug} agent signer`,
  });
  const ownerQuorum = await privy.keyQuorums().create({
    public_keys: [adminKey.publicKey],
    authorization_threshold: 1,
    display_name: `${slug} owners`,
  });

  // 2. Privy organization + empty mandate policy (allowlist starts empty —
  //    payment authority is granted per payee via human-confirmed chat)
  const privyOrg = await privy.organizations().create({
    display_name: name,
    default_key_quorum_id: ownerQuorum.id,
  });
  const policy = await privy.policies().create({
    name: `${slug} mandate`.slice(0, 50),
    version: "1.0",
    chain_type: "ethereum",
    owner_id: ownerQuorum.id,
    rules: [],
  });

  // 3. Treasury wallet, agent attached as bounded signer at create time
  const wallet = await privy.wallets().create({
    chain_type: "ethereum",
    display_name: `${name} Treasury`.slice(0, 50),
    entity: { id: privyOrg.id, type: "organization" },
    owner_id: ownerQuorum.id,
    additional_signers: [
      { signer_id: agentQuorum.id, override_policy_ids: [policy.id] },
    ],
  });

  // 4. Petty-cash EOA (custodied)
  const pettyPk = generatePrivateKey();
  const pettyAddress = privateKeyToAccount(pettyPk).address;

  // 5. ENS subname + per-org subregistry (best-effort)
  let ensLabel: string | null = null;
  let ensRegistry: string | null = null;
  try {
    const provisioned = await provisionOrgEns(slug, wallet.address as Address);
    ensLabel = provisioned.label;
    ensRegistry = provisioned.registry;
  } catch (err) {
    console.error(`ENS provisioning failed for ${slug} (continuing):`, err);
  }

  // 6. Persist + issue the access token
  const token = newToken();
  db.insert(orgs)
    .values({
      id: slug,
      name,
      email,
      tokenHash: hashToken(token),
      privyOrgId: privyOrg.id,
      walletId: wallet.id,
      treasuryAddress: wallet.address,
      policyId: policy.id,
      ownerQuorumId: ownerQuorum.id,
      agentQuorumId: agentQuorum.id,
      adminAuthKey: adminKey.privateKey,
      agentAuthKey: agentKey.privateKey,
      pettyCashPk: pettyPk,
      pettyCashAddress: pettyAddress,
      ensLabel,
      ensRegistry,
      perTxCapUsdc: sanitizeCap(caps?.perTxCapUsdc, "10"),
      dailyCapUsdc: sanitizeCap(caps?.dailyCapUsdc, "200"),
      createdAt: new Date(),
    })
    .run();

  return {
    orgId: slug,
    token,
    treasuryAddress: wallet.address,
    pettyCashAddress: pettyAddress,
    ensName: ensLabel ? `${ensLabel}.${companyName()}.eth` : null,
  };
}

/**
 * Registers <slug>.autocfo.eth in the company root registry with a freshly
 * deployed subregistry, points its addr record at the org treasury, and grants
 * the shared agent ENS key REGISTRAR|RENEW on the org's registry.
 */
async function provisionOrgEns(
  slug: string,
  treasury: Address,
): Promise<{ label: string; registry: string }> {
  const rootRegistry = process.env.ENS_USER_REGISTRY as Address | undefined;
  const resolver = process.env.ENS_RESOLVER as Address | undefined;
  const agentEns = process.env.ENS_AGENT_ADDRESS as Address | undefined;
  if (!rootRegistry || !resolver || !agentEns) throw new Error("ENS env incomplete");

  const owner = ensWallet("owner");
  const pub = ensPublicClient();
  const me = owner.account.address;

  const send = async (to: Address, data: `0x${string}`) => {
    const hash = await owner.sendTransaction({ to, data });
    const receipt = await pub.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`ens tx reverted: ${hash}`);
  };

  // Deploy the org's own subregistry
  const initData = encodeFunctionData({
    abi: REGISTRY_ABI,
    functionName: "initialize",
    args: [
      me,
      ROLE_REGISTRAR | ADMIN(ROLE_REGISTRAR) | ROLE_RENEW | ADMIN(ROLE_RENEW) |
        ROLE_SET_SUBREGISTRY | ADMIN(ROLE_SET_SUBREGISTRY) |
        ROLE_SET_RESOLVER | ADMIN(ROLE_SET_RESOLVER),
    ],
  });
  const salt = BigInt(Date.now());
  const { result: orgRegistry } = await pub.simulateContract({
    address: ENS.VerifiableFactory,
    abi: FACTORY_ABI,
    functionName: "deployProxy",
    args: [ENS.UserRegistryImpl, salt, initData],
    account: me,
  });
  await send(
    ENS.VerifiableFactory,
    encodeFunctionData({
      abi: FACTORY_ABI,
      functionName: "deployProxy",
      args: [ENS.UserRegistryImpl, salt, initData],
    }),
  );

  // Register <slug> under autocfo.eth, wired to the org subregistry
  const expiry = BigInt(Math.floor(Date.now() / 1000) + 365 * 86400);
  await send(
    rootRegistry,
    encodeFunctionData({
      abi: REGISTRY_ABI,
      functionName: "register",
      args: [slug, me, orgRegistry, resolver, 0n, expiry],
    }),
  );

  // Org name resolves to its treasury
  const { payeeNode, RESOLVER_ABI } = await import("./ens.js");
  await send(
    resolver,
    encodeFunctionData({
      abi: RESOLVER_ABI,
      functionName: "setAddr",
      args: [payeeNode(slug), treasury],
    }),
  );

  // Shared agent key may register payees inside the org's registry
  await send(
    orgRegistry,
    encodeFunctionData({
      abi: REGISTRY_ABI,
      functionName: "grantRootRoles",
      args: [ROLE_REGISTRAR | ROLE_RENEW, agentEns],
    }),
  );

  return { label: slug, registry: orgRegistry };
}
