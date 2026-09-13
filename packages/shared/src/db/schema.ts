import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

// Tenants. AutoCFO custodies everything per org: Privy org/wallet/policy and
// both authorization keys, a petty-cash EOA, and an ENSv2 subname registry.
// Access is via a bearer token issued once at onboarding (sha256 stored).
export const orgs = sqliteTable("orgs", {
  id: text("id").primaryKey(), // slug, e.g. "acme"
  name: text("name").notNull(),
  email: text("email").notNull(),
  tokenHash: text("token_hash").notNull(),
  privyOrgId: text("privy_org_id").notNull(),
  walletId: text("wallet_id").notNull(),
  treasuryAddress: text("treasury_address").notNull(),
  policyId: text("policy_id").notNull(),
  ownerQuorumId: text("owner_quorum_id").notNull(),
  agentQuorumId: text("agent_quorum_id").notNull(),
  adminAuthKey: text("admin_auth_key").notNull(),
  agentAuthKey: text("agent_auth_key").notNull(),
  pettyCashPk: text("petty_cash_pk").notNull(),
  pettyCashAddress: text("petty_cash_address").notNull(),
  ensLabel: text("ens_label"),
  ensRegistry: text("ens_registry"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
});

export const payees = sqliteTable("payees", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().default("env"),
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
  orgId: text("org_id").notNull().default("env"),
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

// The payment-authority list mirrored into the Privy policy: each row becomes
// an ALLOW rule (recipient == address AND amount <= cap). Additions happen only
// after explicit human confirmation in chat; the sync signs with the admin key.
export const allowlist = sqliteTable("allowlist", {
  address: text("address").primaryKey(),
  orgId: text("org_id").notNull().default("env"),
  label: text("label").notNull(),
  capBaseUnits: text("cap_base_units").notNull(),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
});

// Standing payment schedules (payroll, subscriptions). Each tick, schedules
// past nextDue are materialized into normal pending invoices by code (not the
// LLM), so recurring payments flow through the same mandate/escalation path.
export const recurring = sqliteTable("recurring", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().default("env"),
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
  orgId: text("org_id").notNull().default("env"),
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
