// Replays a stranded Gateway mint on Base Sepolia (attestation from the
// 2026-09-13 payout test that failed for lack of destination gas).
// Run after funding the petty-cash address with Base Sepolia ETH.
import "../src/env.js";
import { createWalletClient, createPublicClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";

const GATEWAY_MINTER = "0x0022222ABE238Cc2C7Bb1f21003F0a260052475B" as const;
// Full calldata for gatewayMint(attestationPayload, signature) captured from the failed attempt:
const CALLDATA =
  "0x9fb01cc5000000000000000000000000000000000000000000000000000000000000004000000000000000000000000000000000000000000000000000000000000001e0000000000000000000000000000000000000000000000000000000000000017cff6fb3340000000000000000000000000000000000000000000000000000000002c933ac00000154ca85def7000000010000001a000000060000000000000000000000000077777d7eba4688bdef3e311b846f25870a19b90000000000000000000000000022222abe238cc2c7bb1f21003f0a260052475b0000000000000000000000003600000000000000000000000000000000000000000000000000000000000000036cbd53842c5426634e7929541ec2318f3dcf7e000000000000000000000000158d69b73b12c3b8116a1aff06a7e327371b3c3d000000000000000000000000a69a06790bc05b7a09cdde04073b13a1e301f5dc000000000000000000000000158d69b73b12c3b8116a1aff06a7e327371b3c3d000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000f4240fb59f80ee6f0ee6ee84c350ba0cebce42336373f06d06adb45ace61041cd22a000000000000000000000000000000000000000000000000000000000000000000000000000000041241334bac15664ca7268e97dcbab9269c3ff708dc447eeec8e9285c9479ec65b1c6a6fdd54d43d2783a4e50b4499871d2a96ff40105c1989cb21150251f688ab1c00000000000000000000000000000000000000000000000000000000000000" as const;

async function main() {
  const account = privateKeyToAccount(
    process.env.PETTY_CASH_PRIVATE_KEY as `0x${string}`,
  );
  const wallet = createWalletClient({ account, chain: baseSepolia, transport: http() });
  const pub = createPublicClient({ chain: baseSepolia, transport: http() });
  const hash = await wallet.sendTransaction({ to: GATEWAY_MINTER, data: CALLDATA });
  console.log(`mint tx: https://sepolia.basescan.org/tx/${hash}`);
  const receipt = await pub.waitForTransactionReceipt({ hash });
  console.log(`status: ${receipt.status}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
