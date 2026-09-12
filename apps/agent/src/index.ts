import { Hono } from "hono";
import { cors } from "hono/cors";
import { serve } from "@hono/node-server";
import { desc, eq } from "drizzle-orm";
import { getDb, activity, invoices, payees } from "@autocfo/shared/db";
import { runCfoTick } from "./agent.js";
import { getIntent } from "./privy.js";
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

const port = Number(process.env.AGENT_PORT ?? 3001);
serve({ fetch: app.fetch, port }, () =>
  console.log(`AutoCFO agent API on :${port}`),
);

startSeller();
