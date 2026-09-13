// ENSv2 Sepolia spike: registrar params, name availability, price, gas balance.
import "../src/env.js";
import { createPublicClient, http, formatEther, parseAbi } from "viem";
import { sepolia } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";

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

const LABEL = process.env.ENS_LABEL ?? "autocfo";

async function main() {
  const c = createPublicClient({ chain: sepolia, transport: http() });
  const account = privateKeyToAccount(
    process.env.PETTY_CASH_PRIVATE_KEY as `0x${string}`,
  );
  const regAbi = parseAbi([
    "function MIN_COMMITMENT_AGE() view returns (uint64)",
    "function MAX_COMMITMENT_AGE() view returns (uint64)",
    "function MIN_REGISTER_DURATION() view returns (uint64)",
    "function getRegisterPrice(string label, uint64 duration, address paymentToken) view returns (uint256 base, uint256 premium)",
    "function isAvailable(string label) view returns (bool)",
  ]);
  const [eth, minAge, maxAge, minDur, available] = await Promise.all([
    c.getBalance({ address: account.address }),
    c.readContract({ address: ENS.ETHRegistrar, abi: regAbi, functionName: "MIN_COMMITMENT_AGE" }),
    c.readContract({ address: ENS.ETHRegistrar, abi: regAbi, functionName: "MAX_COMMITMENT_AGE" }),
    c.readContract({ address: ENS.ETHRegistrar, abi: regAbi, functionName: "MIN_REGISTER_DURATION" }),
    c.readContract({ address: ENS.ETHRegistrar, abi: regAbi, functionName: "isAvailable", args: [LABEL] }),
  ]);
  const [base, premium] = await c.readContract({
    address: ENS.ETHRegistrar,
    abi: regAbi,
    functionName: "getRegisterPrice",
    args: [LABEL, minDur, ENS.MockUSDC],
  });
  // MockUSDC: does it have an open mint?
  const usdcAbi = parseAbi([
    "function decimals() view returns (uint8)",
    "function balanceOf(address) view returns (uint256)",
  ]);
  const [dec, usdcBal] = await Promise.all([
    c.readContract({ address: ENS.MockUSDC, abi: usdcAbi, functionName: "decimals" }),
    c.readContract({ address: ENS.MockUSDC, abi: usdcAbi, functionName: "balanceOf", args: [account.address] }),
  ]);
  console.log({
    signer: account.address,
    sepoliaEth: formatEther(eth),
    minCommitmentAgeSec: minAge.toString(),
    maxCommitmentAgeSec: maxAge.toString(),
    minRegisterDurationDays: (Number(minDur) / 86400).toFixed(0),
    label: LABEL,
    available,
    priceBase: base.toString(),
    pricePremium: premium.toString(),
    usdcDecimals: dec,
    ourMockUsdc: usdcBal.toString(),
  });
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
