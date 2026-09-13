import "./env.js";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { serve } from "@hono/node-server";
import { and, desc, eq } from "drizzle-orm";
import { erc20Abi } from "viem";
import { randomUUID } from "node:crypto";
import {
  getDb,
  activity,
  allowlist as allowlistTable,
  invoices,
  payees,
  recurring as recurringTable,
} from "@autocfo/shared/db";
import {
  baseUnitsToUsdc,
  explorerTxUrl,
  getChainProfile,
  usdcToBaseUnits,
} from "@autocfo/shared";
import { resetChat, runCfoChat, runCfoTick } from "./agent.js";
import { publicClient, sendUsdcFromTreasury } from "./privy.js";
import { pettyCashState } from "./pettycash.js";
import { startSeller } from "./seller.js";
import { logActivity } from "./activity.js";
import { onboardOrg, type OnboardResult } from "./onboarding.js";
import { privyUserEmail, verifyPrivyUser } from "./privy-auth.js";
import { orgs as orgsTable } from "@autocfo/shared/db";
import { hashToken, newToken } from "./org.js";
import { currentOrg, envOrg, orgFromToken, runWithOrg, type OrgContext } from "./org.js";

type Env = { Variables: { org: OrgContext } };
const app = new Hono<Env>();
app.use("*", cors());

// ---------- public ----------

app.get("/health", (c) => c.json({ ok: true }));

// Self-serve onboarding runs as a background job so the client can render
// step-by-step progress (provisioning takes ~a minute, mostly Sepolia txs).
interface OnboardJob {
  steps: { label: string; status: "running" | "done" }[];
  result: OnboardResult | null;
  error: string | null;
}
const onboardJobs = new Map<string, OnboardJob>();

// Extracts + verifies an OPTIONAL Privy access token from the request.
async function privyUserFrom(c: { req: { header(n: string): string | undefined } }) {
  const auth = c.req.header("Authorization");
  if (!auth?.startsWith("Bearer ") || auth.slice(7).startsWith("acfo_")) return null;
  return verifyPrivyUser(auth.slice(7).trim());
}

app.post("/orgs", async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body?.name) return c.json({ error: "name required" }, 400);

  // Privy-authenticated onboarding: verified email, and log-back-in later.
  let privyUserId: string | null = null;
  let email = String(body.email ?? "");
  try {
    privyUserId = await privyUserFrom(c);
  } catch {
    return c.json({ error: "invalid Privy session — sign in again" }, 401);
  }
  if (privyUserId) {
    const existing = getDb()
      .select()
      .from(orgsTable)
      .where(eq(orgsTable.privyUserId, privyUserId))
      .get();
    if (existing)
      return c.json(
        { error: `you already have an org (${existing.name}) — use "Sign in with Privy"` },
        409,
      );
    email = (await privyUserEmail(privyUserId)) ?? email;
  }
  if (!email) return c.json({ error: "email required" }, 400);

  const jobId = newToken().slice(5, 21);
  const job: OnboardJob = { steps: [], result: null, error: null };
  onboardJobs.set(jobId, job);
  onboardOrg(
    String(body.name),
    email,
    { perTxCapUsdc: body.perTxCapUsdc, dailyCapUsdc: body.dailyCapUsdc },
    {
      privyUserId,
      onStep: (label) => {
        job.steps.forEach((st) => (st.status = "done"));
        job.steps.push({ label, status: "running" });
      },
    },
  )
    .then((result) => {
      job.steps.forEach((st) => (st.status = "done"));
      job.result = result;
    })
    .catch((err) => {
      console.error("onboarding failed:", err);
      job.error = String(err instanceof Error ? err.message : err);
    });
  return c.json({ jobId });
});

app.get("/orgs/status/:jobId", (c) => {
  const job = onboardJobs.get(c.req.param("jobId"));
  if (!job) return c.json({ error: "unknown job" }, 404);
  return c.json(job);
});

// Log back in with Privy: verifies the session, rotates the org's access
// token, and returns the fresh one (old tokens stop working).
app.post("/orgs/login", async (c) => {
  let privyUserId: string | null = null;
  try {
    privyUserId = await privyUserFrom(c);
  } catch {
    return c.json({ error: "invalid Privy session" }, 401);
  }
  if (!privyUserId) return c.json({ error: "Privy token required" }, 401);
  const row = getDb()
    .select()
    .from(orgsTable)
    .where(eq(orgsTable.privyUserId, privyUserId))
    .get();
  if (!row) return c.json({ error: "no org for this account — create one first" }, 404);
  const token = newToken();
  getDb()
    .update(orgsTable)
    .set({ tokenHash: hashToken(token) })
    .where(eq(orgsTable.id, row.id))
    .run();
  return c.json({ orgId: row.id, name: row.name, token });
});

// ---------- tenant scope ----------
// Bearer token → org row. Without a token, fall back to the legacy env org
// ONLY when explicitly allowed (local dev); in production it's 401.

app.use("*", async (c, next) => {
  const auth = c.req.header("Authorization");
  if (auth?.startsWith("Bearer ")) {
    const org = orgFromToken(auth.slice(7).trim());
    if (!org) return c.json({ error: "invalid token" }, 401);
    c.set("org", org);
  } else if (process.env.ALLOW_ENV_ORG !== "false") {
    c.set("org", envOrg());
  } else {
    return c.json({ error: "missing bearer token — onboard at POST /orgs" }, 401);
  }
  return runWithOrg(c.get("org"), () => next());
});

app.get("/me", (c) => {
  const org = c.get("org");
  return c.json({
    orgId: org.orgId,
    name: org.name,
    treasuryAddress: org.treasuryAddress,
    pettyCashAddress: org.pettyCashAddress,
    ensName: org.ensLabel
      ? `${org.ensLabel}.autocfo.eth`
      : org.orgId === "env"
        ? "autocfo.eth"
        : null,
    ensRegistry: org.ensRegistry,
    perTxCapUsdc: org.perTxCapUsdc,
    dailyCapUsdc: org.dailyCapUsdc,
    chain: "Arc testnet (5042002)",
  });
});

// The org's payment authority (mirrors the Privy policy rules).
app.get("/authority", (c) => {
  const org = c.get("org");
  const rows = getDb()
    .select()
    .from(allowlistTable)
    .where(eq(allowlistTable.orgId, org.orgId))
    .all();
  return c.json(
    rows.map((r) => ({
      address: r.address,
      label: r.label,
      capUsdc: baseUnitsToUsdc(BigInt(r.capBaseUnits)),
    })),
  );
});

app.post("/agent/tick", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const result = await runCfoTick(body.instruction);
  return c.json(result);
});

app.post("/agent/chat", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  if (!body.message) return c.json({ error: "message required" }, 400);
  const result = await runCfoChat(String(body.message));
  return c.json(result);
});

app.post("/agent/chat/reset", (c) => {
  resetChat();
  return c.json({ reset: true });
});

app.get("/payees", (c) => {
  const org = c.get("org");
  return c.json(
    getDb().select().from(payees).where(eq(payees.orgId, org.orgId)).all(),
  );
});

// Create an invoice from the dashboard ("upload" an incoming bill).
app.post("/invoices", async (c) => {
  const org = c.get("org");
  const body = await c.req.json().catch(() => null);
  if (!body?.payeeId || !body?.amountUsdc || !body?.memo)
    return c.json({ error: "payeeId, amountUsdc, memo required" }, 400);
  const db = getDb();
  const payee = db
    .select()
    .from(payees)
    .where(and(eq(payees.id, body.payeeId), eq(payees.orgId, org.orgId)))
    .get();
  if (!payee) return c.json({ error: "payee not found" }, 404);
  const count = db.select().from(invoices).all().length;
  const id = `INV-${2000 + count}`;
  const dueDate = body.dueDate
    ? new Date(body.dueDate)
    : new Date(Date.now() + (Number(body.dueInDays ?? 0) || 0) * 86_400_000);
  db.insert(invoices)
    .values({
      id,
      orgId: org.orgId,
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

// Standing schedules (payroll/subscriptions) — materialized into invoices
// at the start of every tick.
app.post("/recurring", async (c) => {
  const org = c.get("org");
  const body = await c.req.json().catch(() => null);
  if (!body?.payeeId || !body?.amountUsdc || !body?.memo)
    return c.json({ error: "payeeId, amountUsdc, memo required" }, 400);
  const db = getDb();
  const payee = db
    .select()
    .from(payees)
    .where(and(eq(payees.id, body.payeeId), eq(payees.orgId, org.orgId)))
    .get();
  if (!payee) return c.json({ error: "payee not found" }, 404);
  const intervalDays = Math.max(1, Math.min(365, Number(body.intervalDays) || 30));
  const startNow = body.startNow !== false;
  const id = `REC-${randomUUID().slice(0, 8)}`;
  db.insert(recurringTable)
    .values({
      id,
      orgId: org.orgId,
      payeeId: payee.id,
      amountBaseUnits: usdcToBaseUnits(String(body.amountUsdc)).toString(),
      memo: String(body.memo),
      intervalDays,
      nextDue: startNow ? new Date() : new Date(Date.now() + intervalDays * 86_400_000),
      active: true,
      createdAt: new Date(),
    })
    .run();
  logActivity({
    kind: "agent_note",
    summary: `Recurring schedule created: ${body.amountUsdc} USDC to ${payee.name} every ${intervalDays} days (${body.memo})`,
    detail: { signal: "recurring_created", scheduleId: id, via: "dashboard" },
  });
  return c.json({ id, created: true });
});

app.get("/recurring", (c) => {
  const org = c.get("org");
  const rows = getDb()
    .select()
    .from(recurringTable)
    .innerJoin(payees, eq(recurringTable.payeeId, payees.id))
    .where(and(eq(recurringTable.orgId, org.orgId), eq(recurringTable.active, true)))
    .all();
  return c.json(
    rows.map((r) => ({
      id: r.recurring.id,
      payeeName: r.payees.name,
      amountUsdc: baseUnitsToUsdc(BigInt(r.recurring.amountBaseUnits)),
      memo: r.recurring.memo,
      intervalDays: r.recurring.intervalDays,
      nextDue: r.recurring.nextDue,
    })),
  );
});

app.get("/invoices", (c) => {
  const org = c.get("org");
  const rows = getDb()
    .select()
    .from(invoices)
    .innerJoin(payees, eq(invoices.payeeId, payees.id))
    .where(eq(invoices.orgId, org.orgId))
    .all();
  return c.json(rows);
});

app.get("/activity", (c) => {
  const org = c.get("org");
  const rows = getDb()
    .select()
    .from(activity)
    .where(eq(activity.orgId, org.orgId))
    .orderBy(desc(activity.ts))
    .limit(100)
    .all();
  return c.json(rows.map((r) => ({ ...r, detail: JSON.parse(r.detail) })));
});

// Human approval endpoints. Approve executes with the OWNER quorum key —
// the one key the agent never holds. This is the escalation path's second half.
app.post("/invoices/:id/approve", async (c) => {
  const org = c.get("org");
  const id = c.req.param("id");
  const db = getDb();
  const inv = db
    .select()
    .from(invoices)
    .where(and(eq(invoices.id, id), eq(invoices.orgId, org.orgId)))
    .get();
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
  const org = c.get("org");
  const id = c.req.param("id");
  const db = getDb();
  const inv = db
    .select()
    .from(invoices)
    .where(and(eq(invoices.id, id), eq(invoices.orgId, org.orgId)))
    .get();
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
// config (pre-funding) by returning null for that lane.
app.get("/treasury", async (c) => {
  const org = c.get("org");
  const [treasury, petty] = await Promise.all([
    (async () => {
      if (!org.treasuryAddress || org.treasuryAddress === "0x") return null;
      const { usdc } = getChainProfile();
      const balance = await publicClient().readContract({
        address: usdc,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [org.treasuryAddress],
      });
      return { address: org.treasuryAddress, usdcBalance: baseUnitsToUsdc(balance) };
    })().catch(() => null),
    (async () => {
      const state = await pettyCashState();
      return JSON.parse(
        JSON.stringify(state, (_k, v) => (typeof v === "bigint" ? v.toString() : v)),
      );
    })().catch(() => null),
  ]);
  return c.json({ treasury, pettyCash: petty });
});

const port = Number(process.env.PORT ?? process.env.AGENT_PORT ?? 3001);
serve({ fetch: app.fetch, port }, () =>
  console.log(`AutoCFO agent API on :${port}`),
);

startSeller();
