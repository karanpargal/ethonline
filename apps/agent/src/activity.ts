import { randomUUID } from "node:crypto";
import { getDb, activity } from "@autocfo/shared/db";

type Kind = (typeof activity.$inferInsert)["kind"];

export function logActivity(opts: {
  kind: Kind;
  summary: string;
  detail?: Record<string, unknown>;
  invoiceId?: string;
  txHash?: string;
}) {
  getDb()
    .insert(activity)
    .values({
      id: randomUUID(),
      ts: new Date(),
      kind: opts.kind,
      summary: opts.summary,
      detail: JSON.stringify(opts.detail ?? {}),
      invoiceId: opts.invoiceId,
      txHash: opts.txHash,
    })
    .run();
}
