// Trailing slashes in the env var would produce "//orgs", which misses the
// public route and 401s — normalize defensively.
const BASE = (process.env.NEXT_PUBLIC_AGENT_API ?? "http://localhost:3001").replace(/\/+$/, "");

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

export interface OnboardResult {
  orgId: string;
  token: string;
  treasuryAddress: string;
  pettyCashAddress: string;
  ensName: string | null;
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
      ensRegistry: string | null;
      perTxCapUsdc: string;
      dailyCapUsdc: string;
      chain: string;
    }>("/me"),
  authority: () =>
    get<{ address: string; label: string; capUsdc: string }[]>("/authority"),
  onboard: async (
    input: {
      name: string;
      email?: string;
      perTxCapUsdc?: string;
      dailyCapUsdc?: string;
    },
    privyToken?: string,
  ): Promise<{ jobId: string }> => {
    const res = await fetch(`${BASE}/orgs`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(privyToken ? { Authorization: `Bearer ${privyToken}` } : {}),
      },
      body: JSON.stringify(input),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error ?? `onboard: ${res.status}`);
    }
    return res.json();
  },
  onboardStatus: (jobId: string) =>
    get<{
      steps: { label: string; status: "running" | "done" }[];
      result: OnboardResult | null;
      error: string | null;
    }>(`/orgs/status/${jobId}`),
  privyLogin: async (privyToken: string) => {
    const res = await fetch(`${BASE}/orgs/login`, {
      method: "POST",
      headers: { Authorization: `Bearer ${privyToken}` },
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      const e = new Error(err.error ?? `login: ${res.status}`) as Error & { status?: number };
      e.status = res.status;
      throw e;
    }
    return res.json() as Promise<{ orgId: string; name: string; token: string }>;
  },
  createInvoice: (input: {
    payeeId: string;
    amountUsdc: string;
    memo: string;
    dueInDays: number;
  }) => post<{ id: string; created: boolean }>("/invoices", input),
  createRecurring: (input: {
    payeeId: string;
    amountUsdc: string;
    memo: string;
    intervalDays: number;
  }) => post<{ id: string; created: boolean }>("/recurring", input),
  recurring: () =>
    get<
      {
        id: string;
        payeeName: string;
        amountUsdc: string;
        memo: string;
        intervalDays: number;
        nextDue: string;
      }[]
    >("/recurring"),
  withdraw: (to: string, amountUsdc: string) =>
    post<{ withdrawn: boolean; txHash: string; explorer: string }>("/treasury/withdraw", {
      to,
      amountUsdc,
    }),
  tick: (instruction?: string) =>
    post<TickResult>("/agent/tick", instruction ? { instruction } : {}),
};

export function formatUsdc(baseUnits: string): string {
  const u = BigInt(baseUnits);
  const whole = u / 1_000_000n;
  const frac = (u % 1_000_000n).toString().padStart(6, "0").slice(0, 2);
  return `${whole.toLocaleString()}.${frac}`;
}
