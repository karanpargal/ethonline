// Tenant context. Every request runs inside an org scope: either a real org
// row (bearer token) or the legacy "env" org backed by .env values, which
// keeps local scripts and the original single-tenant demo working unchanged.
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { getDb, orgs } from "@autocfo/shared/db";

export interface OrgContext {
  orgId: string;
  name: string;
  walletId: string;
  treasuryAddress: `0x${string}`;
  policyId: string;
  adminAuthKey: string;
  agentAuthKey: string;
  pettyCashPk: `0x${string}`;
  pettyCashAddress: `0x${string}`;
  ensLabel: string | null; // org subname label under the company root
  ensRegistry: `0x${string}` | null; // org's own ENSv2 subregistry
  perTxCapUsdc: string;
  dailyCapUsdc: string;
}

const als = new AsyncLocalStorage<OrgContext>();

export function envOrg(): OrgContext {
  return {
    orgId: "env",
    name: "AutoCFO Demo Inc",
    walletId: process.env.PRIVY_TREASURY_WALLET_ID ?? "",
    treasuryAddress: (process.env.PRIVY_TREASURY_ADDRESS ?? "0x") as `0x${string}`,
    policyId: process.env.PRIVY_POLICY_ID ?? "",
    adminAuthKey: process.env.PRIVY_ADMIN_AUTH_KEY ?? "",
    agentAuthKey: process.env.PRIVY_AGENT_AUTH_KEY ?? "",
    pettyCashPk: (process.env.PETTY_CASH_PRIVATE_KEY ?? "0x") as `0x${string}`,
    pettyCashAddress: "0x158D69B73b12C3b8116A1aFF06a7E327371B3c3d",
    ensLabel: null, // env org owns the root name itself
    ensRegistry: (process.env.ENS_USER_REGISTRY ?? null) as `0x${string}` | null,
    perTxCapUsdc: process.env.PER_TX_CAP_USDC ?? "10",
    dailyCapUsdc: process.env.DAILY_BUDGET_USDC ?? "200",
  };
}

export function orgFromRow(row: typeof orgs.$inferSelect): OrgContext {
  return {
    orgId: row.id,
    name: row.name,
    walletId: row.walletId,
    treasuryAddress: row.treasuryAddress as `0x${string}`,
    policyId: row.policyId,
    adminAuthKey: row.adminAuthKey,
    agentAuthKey: row.agentAuthKey,
    pettyCashPk: row.pettyCashPk as `0x${string}`,
    pettyCashAddress: row.pettyCashAddress as `0x${string}`,
    ensLabel: row.ensLabel,
    ensRegistry: (row.ensRegistry ?? null) as `0x${string}` | null,
    perTxCapUsdc: row.perTxCapUsdc,
    dailyCapUsdc: row.dailyCapUsdc,
  };
}

export function runWithOrg<T>(ctx: OrgContext, fn: () => T): T {
  return als.run(ctx, fn);
}

/** Current org; falls back to the env org outside a request scope (scripts). */
export function currentOrg(): OrgContext {
  return als.getStore() ?? envOrg();
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function newToken(): string {
  return `acfo_${randomBytes(24).toString("hex")}`;
}

export function orgFromToken(token: string): OrgContext | null {
  const row = getDb()
    .select()
    .from(orgs)
    .where(eq(orgs.tokenHash, hashToken(token)))
    .get();
  return row ? orgFromRow(row) : null;
}
