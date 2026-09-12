import "./env.js";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { serve } from "@hono/node-server";
import { desc, eq } from "drizzle-orm";
import { getDb, activity, invoices, payees } from "@autocfo/shared/db";
import { erc20Abi } from "viem";
import { baseUnitsToUsdc, getChainProfile } from "@autocfo/shared";
import { runCfoTick } from "./agent.js";
import { getIntent, publicClient } from "./privy.js";
import { pettyCashState } from "./pettycash.js";
import { startSeller } from "./seller.js";

const app = new Hono();
app.use("*", cors());

app.get("/health", (c) => c.json({ ok: true }));

app.post("/agent/tick", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const result = await runCfoTick(body.instruction);
  return c.json(result);
});

app.get("/invoices", (c) => {
  const rows = getDb()
    .select()
    .from(invoices)
    .innerJoin(payees, eq(invoices.payeeId, payees.id))
    .all();
  return c.json(rows);
});

app.get("/activity", (c) => {
  const rows = getDb()
    .select()
    .from(activity)
    .orderBy(desc(activity.ts))
    .limit(100)
    .all();
  return c.json(rows.map((r) => ({ ...r, detail: JSON.parse(r.detail) })));
});

app.get("/intents/:id", async (c) => {
  const intent = await getIntent(c.req.param("id"));
  return c.json(intent);
});

// Balance card data. Each lane resolves independently and tolerates missing
// env (pre-setup) by returning null for that lane.
app.get("/treasury", async (c) => {
  const [treasury, petty] = await Promise.all([
    (async () => {
      const address = process.env.PRIVY_TREASURY_ADDRESS as
        | `0x${string}`
        | undefined;
      if (!address) return null;
      const { usdc } = getChainProfile();
      const balance = await publicClient().readContract({
        address: usdc,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [address],
      });
      return { address, usdcBalance: baseUnitsToUsdc(balance) };
    })().catch(() => null),
    (async () => {
      if (!process.env.PETTY_CASH_PRIVATE_KEY) return null;
      const state = await pettyCashState();
      return JSON.parse(
        JSON.stringify(state, (_k, v) =>
          typeof v === "bigint" ? v.toString() : v,
        ),
      );
    })().catch(() => null),
  ]);
  return c.json({ treasury, pettyCash: petty });
});

const port = Number(process.env.AGENT_PORT ?? 3001);
serve({ fetch: app.fetch, port }, () =>
  console.log(`AutoCFO agent API on :${port}`),
);

startSeller();
