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
import { allowlist, getDb, orgs } from "@autocfo/shared/db";
import { usdcToBaseUnits } from "@autocfo/shared";
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
import { hashToken, newToken, orgFromRow, runWithOrg } from "./org.js";
import { syncPolicyFromAllowlist } from "./policy.js";

export interface OnboardResult {
  orgId: string;
  token: string; // shown ONCE — we store only the hash
  treasuryAddress: string;
  pettyCashAddress: string;
  ensName: string | null;
}

export type StepReporter = (step: string) => void;

// One signer funds all ENS provisioning — concurrent signups must not race
// nonces, so jobs take turns.
let ensQueue: Promise<unknown> = Promise.resolve();
function enqueueEns<T>(fn: () => Promise<T>): Promise<T> {
  const next = ensQueue.then(fn, fn);
  ensQueue = next.catch(() => {});
  return next;
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms / 1000}s`)), ms),
    ),
  ]);
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
  opts?: { privyUserId?: string | null; onStep?: StepReporter },
): Promise<OnboardResult> {
  const step = (label: string) => {
    console.log(`[onboard:${name}] ${label}`);
    opts?.onStep?.(label);
  };
  const db = getDb();
  const base = slugify(name);
  if (!base) throw new Error("org name must contain letters or numbers");
  // Keep slugs unique: acme, acme-1, acme-2, …
  let slug = base;
  let n = 0;
  while (db.select().from(orgs).where(eq(orgs.id, slug)).get()) slug = `${base}-${++n}`;

  const privy: PrivyClient = getPrivy();

  // 1. Keys + quorums (custodied)
  step("Generating signing keys");
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

  step("Creating your organization & spending mandate");
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

  step("Creating the treasury wallet (agent bounded by policy)");
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

  step("Setting up the petty-cash account");
  // 4. Petty-cash EOA (custodied)
  const pettyPk = generatePrivateKey();
  const pettyAddress = privateKeyToAccount(pettyPk).address;

  // 5. ENS subname + per-org subregistry (best-effort). Serialized through a
  //    queue (one signer = nonce races between concurrent signups) and hard-
  //    capped so a slow Sepolia RPC can never hang onboarding forever.
  let ensLabel: string | null = null;
  let ensRegistry: string | null = null;
  step("Minting your ENS name on Sepolia (the slow part)");
  try {
    const provisioned = await enqueueEns(() =>
      withTimeout(provisionOrgEns(slug, wallet.address as Address), 180_000, "ENS provisioning"),
    );
    ensLabel = provisioned.label;
    ensRegistry = provisioned.registry;
  } catch (err) {
    console.error(`ENS provisioning failed for ${slug} (continuing):`, err);
    step("ENS mint skipped (Sepolia was slow — org continues without a name)");
  }

  // 6. Persist + issue the access token
  step("Issuing your access token");
  const token = newToken();
  db.insert(orgs)
    .values({
      id: slug,
      name,
      email,
      tokenHash: hashToken(token),
      privyUserId: opts?.privyUserId ?? null,
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

  // 7. The org's own petty-cash wallet is always payment-authorized (it's
  //    internal money movement — top-ups must not need a human grant).
  step("Authorizing the petty-cash lane");
  try {
    db.insert(allowlist)
      .values({
        address: pettyAddress,
        orgId: slug,
        label: "Petty cash wallet",
        capBaseUnits: usdcToBaseUnits(sanitizeCap(caps?.perTxCapUsdc, "10")).toString(),
        createdAt: new Date(),
      })
      .run();
    const row = db.select().from(orgs).where(eq(orgs.id, slug)).get();
    if (row) await runWithOrg(orgFromRow(row), () => syncPolicyFromAllowlist());
  } catch (err) {
    console.error(`[onboard:${name}] petty-cash authorization failed (grant it in chat):`, err);
  }

  console.log(
    `[onboard:${name}] complete org=${slug} treasury=${wallet.address} ens=${ensLabel ?? "none"}`,
  );
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

  let txIdx = 0;
  const send = async (to: Address, data: `0x${string}`) => {
    const hash = await owner.sendTransaction({ to, data });
    console.log(`[ens:${slug}] tx ${++txIdx} sent ${hash} → waiting…`);
    const receipt = await pub.waitForTransactionReceipt({ hash, timeout: 60_000 });
    if (receipt.status !== "success") throw new Error(`ens tx reverted: ${hash}`);
    console.log(`[ens:${slug}] tx ${txIdx} confirmed (block ${receipt.blockNumber})`);
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

  // Register <slug> under autocfo.eth, wired to the org subregistry.
  // A retried signup may have registered the label in an earlier stuck run —
  // if we already own it, skip the register instead of reverting.
  const expiry = BigInt(Math.floor(Date.now() / 1000) + 365 * 86400);
  const existingOwner = await pub.readContract({
    address: rootRegistry,
    abi: REGISTRY_ABI,
    functionName: "findOwner",
    args: [slug],
  });
  if (existingOwner === "0x0000000000000000000000000000000000000000") {
    await send(
      rootRegistry,
      encodeFunctionData({
        abi: REGISTRY_ABI,
        functionName: "register",
        args: [slug, me, orgRegistry, resolver, 0n, expiry],
      }),
    );
  } else if (existingOwner.toLowerCase() !== me.toLowerCase()) {
    throw new Error(`label ${slug} already owned by ${existingOwner}`);
  } else {
    // Label left over from a previous deployment/wipe: rewire it to the NEW
    // org subregistry, otherwise payees would register in one registry while
    // resolution walks the stale one.
    const tokenId = await pub.readContract({
      address: rootRegistry,
      abi: REGISTRY_ABI,
      functionName: "findTokenId",
      args: [slug],
    });
    await send(
      rootRegistry,
      encodeFunctionData({
        abi: REGISTRY_ABI,
        functionName: "setSubregistry",
        args: [tokenId, orgRegistry],
      }),
    );
    console.log(`[ens:${slug}] reused existing label, rewired subregistry → ${orgRegistry}`);
  }

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
