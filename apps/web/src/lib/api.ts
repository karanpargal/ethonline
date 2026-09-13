const BASE = process.env.NEXT_PUBLIC_AGENT_API ?? "http://localhost:3001";

const TOKEN_KEY = "autocfo_token";
export const getToken = () =>
  typeof window === "undefined" ? null : localStorage.getItem(TOKEN_KEY);
export const setToken = (t: string) => localStorage.setItem(TOKEN_KEY, t);
export const clearToken = () => localStorage.removeItem(TOKEN_KEY);

export class UnauthorizedError extends Error {}

function authHeaders(): Record<string, string> {
  const t = getToken();
  return t ? { Authorization: `Bearer ${t}` } : {};
}

export interface InvoiceRow {
  invoices: {
    id: string;
    amountBaseUnits: string;
    memo: string;
    dueDate: string;
    status: "pending" | "paid" | "awaiting_approval" | "flagged" | "rejected";
    txHash: string | null;
    privyIntentId: string | null;
  };
  payees: {
    id: string;
    name: string;
    address: string;
    ensName: string | null;
    preferredChain: string;
    allowlisted: boolean;
  };
}

export interface ActivityRow {
  id: string;
  ts: string;
  kind: string;
  summary: string;
  detail: Record<string, unknown>;
  invoiceId: string | null;
  txHash: string | null;
}

export interface TickResult {
  summary: string;
  steps: { toolCalls: { tool: string; input: unknown }[] }[];
}

export interface TreasuryState {
  treasury: { address: string; usdcBalance: string } | null;
  pettyCash: {
    address: string;
    balances?: {
      wallet?: { balance?: string; formatted?: string };
      gateway?: {
        available?: string;
        formattedAvailable?: string;
        formattedTotal?: string;
      };
    };
  } | null;
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { cache: "no-store", headers: authHeaders() });
  if (res.status === 401) throw new UnauthorizedError();
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return res.json();
}

async function post<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...authHeaders() },
    body: body ? JSON.stringify(body) : undefined,
    // Chat turns with several on-chain tool calls can take a while.
    signal: AbortSignal.timeout(300_000),
  });
  if (res.status === 401) throw new UnauthorizedError();
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error ?? `${path}: ${res.status}`);
  }
  return res.json();
}

export interface Payee {
  id: string;
  name: string;
  address: string;
  preferredChain: string;
  allowlisted: boolean;
}

export const api = {
  invoices: () => get<InvoiceRow[]>("/invoices"),
  activity: () => get<ActivityRow[]>("/activity"),
  treasury: () => get<TreasuryState>("/treasury"),
  approve: (invoiceId: string) =>
    post<{ paid: boolean; txHash: string }>(`/invoices/${invoiceId}/approve`),
  reject: (invoiceId: string) =>
    post<{ rejected: boolean }>(`/invoices/${invoiceId}/reject`),
  payees: () => get<Payee[]>("/payees"),
  chat: (message: string) =>
    post<{ reply: string; toolsUsed: string[] }>("/agent/chat", { message }),
  chatReset: () => post<{ reset: boolean }>("/agent/chat/reset"),
  me: () =>
    get<{
      orgId: string;
      name: string;
      treasuryAddress: string;
      pettyCashAddress: string;
      ensName: string | null;
    }>("/me"),
  onboard: (name: string, email: string) =>
    post<{
      orgId: string;
      token: string;
      treasuryAddress: string;
      pettyCashAddress: string;
      ensName: string | null;
    }>("/orgs", { name, email }),
  createInvoice: (input: {
    payeeId: string;
    amountUsdc: string;
    memo: string;
    dueInDays: number;
  }) => post<{ id: string; created: boolean }>("/invoices", input),
  tick: (instruction?: string) =>
    post<TickResult>("/agent/tick", instruction ? { instruction } : {}),
};

export function formatUsdc(baseUnits: string): string {
  const u = BigInt(baseUnits);
  const whole = u / 1_000_000n;
  const frac = (u % 1_000_000n).toString().padStart(6, "0").slice(0, 2);
  return `${whole.toLocaleString()}.${frac}`;
}
