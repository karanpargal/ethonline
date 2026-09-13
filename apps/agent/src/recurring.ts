import { randomUUID } from "node:crypto";
import { and, eq, lte } from "drizzle-orm";
import { getDb, invoices, payees, recurring } from "@autocfo/shared/db";
import { baseUnitsToUsdc } from "@autocfo/shared";
import { logActivity } from "./activity.js";
import { currentOrg } from "./org.js";

/**
 * Materializes due schedules into pending invoices. Deterministic code, run at
 * the start of every tick — the LLM never invents payroll amounts or dates.
 */
export function materializeRecurring(): number {
  const db = getDb();
  const due = db
    .select()
    .from(recurring)
    .where(and(eq(recurring.active, true), eq(recurring.orgId, currentOrg().orgId), lte(recurring.nextDue, new Date())))
    .all();
  for (const r of due) {
    const payee = db.select().from(payees).where(eq(payees.id, r.payeeId)).get();
    db.insert(invoices)
      .values({
        id: `INV-${randomUUID().slice(0, 8)}`,
        orgId: currentOrg().orgId,
        payeeId: r.payeeId,
        amountBaseUnits: r.amountBaseUnits,
        memo: `${r.memo} (recurring)`,
        dueDate: r.nextDue,
        status: "pending",
        createdAt: new Date(),
      })
      .run();
    db.update(recurring)
      .set({ nextDue: new Date(r.nextDue.getTime() + r.intervalDays * 86_400_000) })
      .where(eq(recurring.id, r.id))
      .run();
    logActivity({
      kind: "agent_note",
      summary: `Recurring schedule generated an invoice: ${baseUnitsToUsdc(BigInt(r.amountBaseUnits))} USDC to ${payee?.name ?? r.payeeId} (${r.memo})`,
      detail: { signal: "recurring_due", scheduleId: r.id, intervalDays: r.intervalDays },
    });
  }
  return due.length;
}
