import { defineChain, type Chain } from "viem";
import { baseSepolia } from "viem/chains";

// USDC on Arc is BOTH the native gas token (18 decimals) and an ERC-20
// (6 decimals) at this address — same underlying balance, two representations.
// Always display ONE balance row, sourced from the ERC-20 interface.
export const ARC_TESTNET_USDC =
  "0x3600000000000000000000000000000000000000" as const;

export const USDC_DECIMALS = 6;

// Arc testnet enforces a 20 gwei minimum base fee; txs below it are rejected.
export const ARC_MIN_BASE_FEE_GWEI = 20n;

export const arcTestnet = defineChain({
  id: 5042002,
  name: "Arc Testnet",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: {
    default: { http: ["https://rpc.testnet.arc.io"] },
  },
  blockExplorers: {
    default: { name: "Arcscan", url: "https://testnet.arcscan.app" },
  },
  contracts: {
    multicall3: {
      address: "0xcA11bde05977b3631167028862bE2a173976CA11",
    },
  },
  testnet: true,
});

export type SupportedChainKey = "arc-testnet" | "arc-mainnet" | "base-sepolia";

interface ChainProfile {
  chain: Chain;
  usdc: `0x${string}`;
  gatewayDomain: number | null;
  caip2: string;
}

// Arc mainnet launches Sept 16, 2026 — config intentionally unset until
// docs.arc.io publishes official values (aggregator chain IDs conflict).
const PROFILES: Record<SupportedChainKey, ChainProfile | null> = {
  "arc-testnet": {
    chain: arcTestnet,
    usdc: ARC_TESTNET_USDC,
    gatewayDomain: 26,
    caip2: `eip155:${arcTestnet.id}`,
  },
  "arc-mainnet": null,
  "base-sepolia": {
    chain: baseSepolia,
    usdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    gatewayDomain: 6,
    caip2: `eip155:${baseSepolia.id}`,
  },
};

export function getChainProfile(
  key: SupportedChainKey = (process.env.CHAIN as SupportedChainKey) ??
    "arc-testnet",
): ChainProfile {
  const profile = PROFILES[key];
  if (!profile) {
    throw new Error(
      `Chain profile "${key}" is not configured yet (Arc mainnet config lands Sept 16 — take values from docs.arc.io only)`,
    );
  }
  return profile;
}

export function explorerTxUrl(hash: string, key?: SupportedChainKey): string {
  const { chain } = getChainProfile(key);
  return `${chain.blockExplorers?.default.url}/tx/${hash}`;
}
