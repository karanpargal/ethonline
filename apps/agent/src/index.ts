import "./env.js";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { serve } from "@hono/node-server";
import { desc, eq } from "drizzle-orm";
import { getDb, activity, invoices, payees } from "@autocfo/shared/db";
import { erc20Abi } from "viem";
import {
  baseUnitsToUsdc,
  explorerTxUrl,
  getChainProfile,
  usdcToBaseUnits,
} from "@autocfo/shared";
import { runCfoTick } from "./agent.js";
import { publicClient, sendUsdcFromTreasury } from "./privy.js";
import { pettyCashState } from "./pettycash.js";
import { startSeller } from "./seller.js";
import { logActivity } from "./activity.js";

const app = new Hono();
app.use("*", cors());

app.get("/health", (c) => c.json({ ok: true }));

app.post("/agent/tick", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const result = await runCfoTick(body.instruction);
  return c.json(result);
});

app.get("/payees", (c) => {
  return c.json(getDb().select().from(payees).all());
});

// Create an invoice from the dashboard ("upload" an incoming bill).
app.post("/invoices", async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body?.payeeId || !body?.amountUsdc || !body?.memo)
    return c.json({ error: "payeeId, amountUsdc, memo required" }, 400);
  const db = getDb();
  const payee = db.select().from(payees).where(eq(payees.id, body.payeeId)).get();
  if (!payee) return c.json({ error: "payee not found" }, 404);
  const count = db.select().from(invoices).all().length;
  const id = `INV-${2000 + count}`;
  const dueDate = body.dueDate
    ? new Date(body.dueDate)
    : new Date(Date.now() + (Number(body.dueInDays ?? 0) || 0) * 86_400_000);
  db.insert(invoices)
    .values({
      id,
      payeeId: payee.id,
      amountBaseUnits: usdcToBaseUnits(String(body.amountUsdc)).toString(),
      memo: String(body.memo),
      dueDate,
      status: "pending",
      createdAt: new Date(),
    })
    .run();
  return c.json({ id, created: true });
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

// Human approval endpoints. Approve executes with the OWNER quorum key —
// the one key the agent never holds. This is the escalation path's second half.
app.post("/invoices/:id/approve", async (c) => {
  const id = c.req.param("id");
  const db = getDb();
  const inv = db.select().from(invoices).where(eq(invoices.id, id)).get();
  if (!inv) return c.json({ error: "invoice not found" }, 404);
  if (inv.status !== "awaiting_approval")
    return c.json({ error: `invoice is ${inv.status}` }, 409);
  const payee = db.select().from(payees).where(eq(payees.id, inv.payeeId)).get();
  if (!payee) return c.json({ error: "payee not found" }, 404);
  try {
    const { hash } = await sendUsdcFromTreasury(
      payee.address as `0x${string}`,
      BigInt(inv.amountBaseUnits),
      "owner",
    );
    db.update(invoices).set({ status: "paid", txHash: hash }).where(eq(invoices.id, id)).run();
    logActivity({
      kind: "invoice_paid",
      summary: `Owner approved: paid ${baseUnitsToUsdc(BigInt(inv.amountBaseUnits))} USDC to ${payee.name}`,
      detail: {
        signal: "human_approval",
        approvedWith: "owner quorum key",
        explorer: explorerTxUrl(hash),
      },
      invoiceId: id,
      txHash: hash,
    });
    return c.json({ paid: true, txHash: hash });
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

app.post("/invoices/:id/reject", async (c) => {
  const id = c.req.param("id");
  const db = getDb();
  const inv = db.select().from(invoices).where(eq(invoices.id, id)).get();
  if (!inv) return c.json({ error: "invoice not found" }, 404);
  db.update(invoices).set({ status: "rejected" }).where(eq(invoices.id, id)).run();
  logActivity({
    kind: "agent_note",
    summary: `Owner rejected invoice ${id}`,
    detail: { signal: "human_rejection" },
    invoiceId: id,
  });
  return c.json({ rejected: true });
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
