import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

export const payees = sqliteTable("payees", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  address: text("address").notNull(),
  ensName: text("ens_name"),
  // Chain the payee wants to be paid on; Gateway mints there.
  preferredChain: text("preferred_chain").notNull().default("arc-testnet"),
  // Mirrors membership in the Privy "approved-payees" condition set.
  allowlisted: integer("allowlisted", { mode: "boolean" })
    .notNull()
    .default(false),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
});

export const invoices = sqliteTable("invoices", {
  id: text("id").primaryKey(),
  payeeId: text("payee_id")
    .notNull()
    .references(() => payees.id),
  // USDC amount in 6-decimal base units, stored as string to avoid JS float issues.
  amountBaseUnits: text("amount_base_units").notNull(),
  memo: text("memo").notNull(),
  dueDate: integer("due_date", { mode: "timestamp" }).notNull(),
  status: text("status", {
    enum: [
      "pending",
      "paid",
      "awaiting_approval",
      "flagged",
      "rejected",
    ],
  })
    .notNull()
    .default("pending"),
  txHash: text("tx_hash"),
  privyIntentId: text("privy_intent_id"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
});

// Standing payment schedules (payroll, subscriptions). Each tick, schedules
// past nextDue are materialized into normal pending invoices by code (not the
// LLM), so recurring payments flow through the same mandate/escalation path.
export const recurring = sqliteTable("recurring", {
  id: text("id").primaryKey(),
  payeeId: text("payee_id")
    .notNull()
    .references(() => payees.id),
  amountBaseUnits: text("amount_base_units").notNull(),
  memo: text("memo").notNull(),
  intervalDays: integer("interval_days").notNull(),
  nextDue: integer("next_due", { mode: "timestamp" }).notNull(),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
});

// Audit trail: every agent decision links signal → decision → policy result → tx.
export const activity = sqliteTable("activity", {
  id: text("id").primaryKey(),
  ts: integer("ts", { mode: "timestamp" }).notNull(),
  kind: text("kind", {
    enum: [
      "invoice_paid",
      "intent_proposed",
      "policy_denied",
      "anomaly_flagged",
      "x402_purchase",
      "petty_cash_topup",
      "cross_chain_payout",
      "payee_onboarded",
      "agent_note",
    ],
  }).notNull(),
  summary: text("summary").notNull(),
  // JSON blob: { signal, decision, policyResult, amounts, urls... }
  detail: text("detail").notNull().default("{}"),
  invoiceId: text("invoice_id"),
  txHash: text("tx_hash"),
});
