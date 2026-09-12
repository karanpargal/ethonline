// E2E test of the petty-cash x402 lane: Gateway deposit → gasless pay → balances.
import "../src/env.js";
import { pettyCash, pettyCashState } from "../src/pettycash.js";

async function main() {
  const client = pettyCash();
  console.log("petty cash:", client.address);

  const before = await pettyCashState();
  console.log("before:", JSON.stringify(before.balances, bigintSafe, 1));

  const gatewayAvailable =
    (before.balances as { gateway?: { available?: bigint | string } }).gateway
      ?.available ?? 0n;
  if (BigInt(gatewayAvailable) < 100_000n) {
    console.log("depositing 5 USDC into Gateway…");
    const dep = await client.deposit("5");
    console.log("deposit result:", JSON.stringify(dep, bigintSafe));
  }

  const url = process.env.X402_MARKET_URL ?? "http://localhost:3002/api/market-brief";
  console.log(`paying for ${url} …`);
  const result = await client.pay(url);
  console.log("bought data:", JSON.stringify(result.data));

  const after = await pettyCashState();
  console.log("after:", JSON.stringify(after.balances, bigintSafe, 1));
}

function bigintSafe(_k: string, v: unknown) {
  return typeof v === "bigint" ? v.toString() : v;
}

main().catch((e) => {
  console.error("x402 test failed:", e);
  process.exit(1);
});
