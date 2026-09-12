import express from "express";
import { createGatewayMiddleware } from "@circle-fin/x402-batching/server";

/**
 * Demo x402 seller: "MarketFeed Data Inc" — the data vendor from the seed data.
 * Sells a market brief for $0.001 per call, settled gaslessly in batches via
 * Circle Gateway on Arc testnet. Makes the demo self-contained: our agent is
 * the buyer, this service is the seller.
 */
export function startSeller() {
  const sellerAddress = process.env.SELLER_ADDRESS;
  if (!sellerAddress) {
    console.warn("SELLER_ADDRESS not set — x402 seller not started");
    return;
  }

  const app = express();
  const gateway = createGatewayMiddleware({
    sellerAddress: sellerAddress as `0x${string}`,
    networks: ["eip155:5042002"],
  });

  app.get("/api/market-brief", gateway.require("$0.001"), (_req, res) => {
    res.json({
      asOf: new Date().toISOString(),
      rates: { EURUSD: 1.0842, USDJPY: 148.31, GBPUSD: 1.2618 },
      stablecoinSupply: { USDC: "76.4B", EURC: "312M" },
      note: "Synthetic demo data from MarketFeed Data Inc — paid per call via x402.",
    });
  });

  const port = Number(process.env.SELLER_PORT ?? 3002);
  app.listen(port, () => console.log(`x402 seller (MarketFeed) on :${port}`));
}
