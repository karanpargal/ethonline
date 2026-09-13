// Org-wide daily budget. Per-payee per-tx caps are TEE-enforced by the Privy
// policy; the daily budget is enforced HERE, deterministically, before any
// agent-initiated send (Privy's stateful-policy aggregations have no SDK
// surface as of @privy-io/node 0.34). Owner-approved payments bypass it —
// an explicit human decision outranks the agent's budget.
import { randomUUID } from "node:crypto";
import { and, eq, gte } from "drizzle-orm";
import { getDb, outflows } from "@autocfo/shared/db";
import { baseUnitsToUsdc, usdcToBaseUnits } from "@autocfo/shared";
import { currentOrg } from "./org.js";

function startOfUtcDay(): Date {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

export function spentTodayBaseUnits(): bigint {
  const rows = getDb()
    .select()
    .from(outflows)
    .where(
      and(eq(outflows.orgId, currentOrg().orgId), gte(outflows.ts, startOfUtcDay())),
    )
    .all();
  return rows.reduce((s, r) => s + BigInt(r.baseUnits), 0n);
}

/** Returns null if within budget, otherwise a human-readable denial. */
export function checkDailyBudget(amountBaseUnits: bigint): string | null {
  const org = currentOrg();
  const cap = usdcToBaseUnits(org.dailyCapUsdc);
  const spent = spentTodayBaseUnits();
  if (spent + amountBaseUnits > cap) {
    return `daily budget exceeded: spent ${baseUnitsToUsdc(spent)} of ${org.dailyCapUsdc} USDC today; this payment of ${baseUnitsToUsdc(amountBaseUnits)} USDC would go over — escalate for human approval instead`;
  }
  return null;
}

export function recordOutflow(amountBaseUnits: bigint, kind: "invoice" | "cross_chain" | "topup") {
  getDb()
    .insert(outflows)
    .values({
      id: randomUUID(),
      orgId: currentOrg().orgId,
      ts: new Date(),
      baseUnits: amountBaseUnits.toString(),
      kind,
    })
    .run();
}
