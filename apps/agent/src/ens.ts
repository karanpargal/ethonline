// ENSv2 (Sepolia beta) integration.
//
// The payee registry lives on-chain in ENSv2: the company name (autocfo.eth)
// owns a UserRegistry; each payee is a subname (nimbushost.autocfo.eth) whose
// resolver records carry the payout address and preferred chain. The agent
// holds a SEPARATE key granted only ROLE_REGISTRAR|ROLE_RENEW on that registry
// via Enhanced Access Control — it can onboard payees but cannot touch the
// parent name. Payment addresses are resolved from ENSv2 at pay time.
//
// Contract addresses from https://docs.ens.domains/learn/deployments (beta —
// verified on-chain 2026-09-13; registrar↔registry wiring cross-checked).
import { namehash, parseAbi, createPublicClient, createWalletClient, http, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import { normalize } from "viem/ens";

export const ENS = {
  ETHRegistry: "0xbdc85dd5b15d7ecb354cd7cb6f2c50b4f2c4f0e2",
  RootRegistry: "0x8115186e8f2e0b0281e86ab91f0f48ba90364354",
  UniversalResolverV2: "0x4a1817d13e9cf196f471725176355c1234b63c70",
  PublicResolverV2: "0xe7b9a25607e02da8145e4eb1836ca539e53f11f7",
  ETHRegistrar: "0xa88553f454b77203b0d036a05c894d555eaaa2cc",
  UserRegistryImpl: "0x624a25d67b59d587752ebec8dded8827dae52050",
  MockUSDC: "0x768f42455a2d082e23ceef7d51e5787c82d67a39",
  VerifiableFactory: "0x10dc6333cdfe1fcef624c6e0a8221b91804cd7ef",
} as const;

// RegistryRolesLib (ensdomains/namechain contracts/src/registry/libraries)
export const ROLE_REGISTRAR = 1n << 0n;
export const ROLE_RENEW = 1n << 16n;
export const ROLE_SET_SUBREGISTRY = 1n << 20n;
export const ROLE_SET_RESOLVER = 1n << 24n;
// Admin variants live 128 bits up.
export const ADMIN = (role: bigint) => role << 128n;

export const REGISTRY_ABI = parseAbi([
  "function initialize(address rootAccount, uint256 roleBitmap)",
  "function register(string label, address owner, address registry, address resolver, uint256 roleBitmap, uint64 expiry) returns (uint256)",
  "function grantRootRoles(uint256 roleBitmap, address account) returns (bool)",
  "function hasRootRoles(uint256 roleBitmap, address account) view returns (bool)",
  "function findOwner(string label) view returns (address)",
  "function getResolver(string label) view returns (address)",
  "function findExpiry(string label) view returns (uint64)",
]);

export const REGISTRAR_ABI = parseAbi([
  "function makeCommitment(string label, address owner, bytes32 secret, address subregistry, address resolver, uint64 duration, bytes32 referrer) pure returns (bytes32)",
  "function commit(bytes32 commitment)",
  "function register(string label, address owner, bytes32 secret, address subregistry, address resolver, uint64 duration, address paymentToken, bytes32 referrer) returns (uint256)",
  "function getRegisterPrice(string label, uint64 duration, address paymentToken) view returns (uint256 base, uint256 premium)",
  "function isAvailable(string label) view returns (bool)",
  "function MIN_COMMITMENT_AGE() view returns (uint64)",
  "function MIN_REGISTER_DURATION() view returns (uint64)",
]);

export const RESOLVER_ABI = parseAbi([
  "function setAddr(bytes32 node, address _addr)",
  "function setText(bytes32 node, string key, string value)",
  "function addr(bytes32 node) view returns (address)",
  "function text(bytes32 node, string key) view returns (string)",
]);

export const FACTORY_ABI = parseAbi([
  "function deployProxy(address implementation, uint256 salt, bytes data) returns (address proxy)",
]);

export const MOCK_USDC_ABI = parseAbi([
  "function mint(address to, uint256 amount)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function balanceOf(address owner) view returns (uint256)",
]);

export const ensPublicClient = () =>
  createPublicClient({ chain: sepolia, transport: http(process.env.SEPOLIA_RPC_URL) });

export function ensWallet(kind: "owner" | "agent") {
  const pk =
    kind === "owner"
      ? process.env.PETTY_CASH_PRIVATE_KEY // doubles as the ENS ops/owner key
      : process.env.ENS_AGENT_PRIVATE_KEY;
  if (!pk) throw new Error(`missing key for ens ${kind}`);
  const account = privateKeyToAccount(pk as `0x${string}`);
  return createWalletClient({
    account,
    chain: sepolia,
    transport: http(process.env.SEPOLIA_RPC_URL),
  });
}

export const companyName = () => process.env.ENS_COMPANY_LABEL ?? "autocfo";
export const payeeNode = (label: string) =>
  namehash(normalize(`${label}.${companyName()}.eth`));

/**
 * Resolve a payee name (e.g. "nimbushost.autocfo.eth") through ENSv2's
 * Universal Resolver on Sepolia. Returns address + preferred chain text record.
 */
export async function resolvePayee(fullName: string): Promise<{
  address: Address | null;
  preferredChain: string | null;
}> {
  const client = ensPublicClient();
  const name = normalize(fullName);
  const [address, preferredChain] = await Promise.all([
    client.getEnsAddress({
      name,
      universalResolverAddress: ENS.UniversalResolverV2,
    }),
    client
      .getEnsText({
        name,
        key: "autocfo.chain",
        universalResolverAddress: ENS.UniversalResolverV2,
      })
      .catch(() => null),
  ]);
  return { address, preferredChain };
}
