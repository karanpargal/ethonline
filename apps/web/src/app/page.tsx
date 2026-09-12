"use client";

import { useCallback, useEffect, useState } from "react";
import {
  api,
  formatUsdc,
  type ActivityRow,
  type InvoiceRow,
  type TickResult,
} from "@/lib/api";

const STATUS_STYLES: Record<string, string> = {
  pending: "bg-amber-500/15 text-amber-400 border-amber-500/30",
  paid: "bg-emerald-500/15 text-emerald-400 border-emerald-500/30",
  awaiting_approval: "bg-sky-500/15 text-sky-400 border-sky-500/30",
  flagged: "bg-rose-500/15 text-rose-400 border-rose-500/30",
  rejected: "bg-zinc-500/15 text-zinc-400 border-zinc-500/30",
};

const KIND_ICONS: Record<string, string> = {
  invoice_paid: "✓",
  intent_proposed: "⇧",
  policy_denied: "⛔",
  anomaly_flagged: "⚠",
  x402_purchase: "µ",
  petty_cash_topup: "+",
  cross_chain_payout: "⇄",
  agent_note: "·",
};

export default function Dashboard() {
  const [invoices, setInvoices] = useState<InvoiceRow[]>([]);
  const [activity, setActivity] = useState<ActivityRow[]>([]);
  const [tick, setTick] = useState<TickResult | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [inv, act] = await Promise.all([api.invoices(), api.activity()]);
      setInvoices(inv);
      setActivity(act);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 5000);
    return () => clearInterval(t);
  }, [refresh]);

  const runTick = async () => {
    setRunning(true);
    setTick(null);
    try {
      const result = await api.tick();
      setTick(result);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  };

  const pending = invoices.filter((i) => i.invoices.status === "pending");
  const awaiting = invoices.filter(
    (i) => i.invoices.status === "awaiting_approval",
  );

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      <header className="border-b border-zinc-800 px-8 py-5 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">AutoCFO</h1>
          <p className="text-sm text-zinc-500">
            Autonomous treasury · policy-guarded on Arc
          </p>
        </div>
        <button
          onClick={runTick}
          disabled={running}
          className="rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 px-4 py-2 text-sm font-medium transition"
        >
          {running ? "Agent working…" : "Run agent tick"}
        </button>
      </header>

      {error && (
        <div className="mx-8 mt-4 rounded-lg border border-rose-500/30 bg-rose-500/10 px-4 py-2 text-sm text-rose-300">
          {error} — is the agent service running on :3001?
        </div>
      )}

      <main className="grid grid-cols-1 gap-6 p-8 lg:grid-cols-3">
        <section className="lg:col-span-2 space-y-6">
          <div className="grid grid-cols-3 gap-4">
            <StatCard label="Pending invoices" value={String(pending.length)} />
            <StatCard label="Awaiting approval" value={String(awaiting.length)} />
            <StatCard
              label="Pending total"
              value={`$${formatUsdc(
                pending
                  .reduce((s, i) => s + BigInt(i.invoices.amountBaseUnits), 0n)
                  .toString(),
              )}`}
            />
          </div>

          <div className="rounded-xl border border-zinc-800 overflow-hidden">
            <div className="border-b border-zinc-800 px-5 py-3 text-sm font-medium text-zinc-400">
              Invoices
            </div>
            <table className="w-full text-sm">
              <tbody>
                {invoices.map((row) => (
                  <tr
                    key={row.invoices.id}
                    className="border-b border-zinc-900 last:border-0"
                  >
                    <td className="px-5 py-3">
                      <div className="font-medium">{row.payees.name}</div>
                      <div className="text-xs text-zinc-500">
                        {row.invoices.memo}
                      </div>
                    </td>
                    <td className="px-3 py-3 text-right font-mono">
                      ${formatUsdc(row.invoices.amountBaseUnits)}
                    </td>
                    <td className="px-3 py-3 text-xs text-zinc-500">
                      due{" "}
                      {new Date(row.invoices.dueDate).toLocaleDateString()}
                    </td>
                    <td className="px-5 py-3 text-right">
                      <span
                        className={`inline-block rounded-full border px-2.5 py-0.5 text-xs ${STATUS_STYLES[row.invoices.status]}`}
                      >
                        {row.invoices.status.replace("_", " ")}
                      </span>
                    </td>
                  </tr>
                ))}
                {invoices.length === 0 && (
                  <tr>
                    <td className="px-5 py-8 text-center text-zinc-600">
                      No invoices — run the seed script.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          {tick && (
            <div className="rounded-xl border border-emerald-800/40 bg-emerald-950/20 p-5">
              <div className="mb-2 text-sm font-medium text-emerald-400">
                Agent summary
              </div>
              <p className="whitespace-pre-wrap text-sm text-zinc-300">
                {tick.summary}
              </p>
            </div>
          )}
        </section>

        <section className="rounded-xl border border-zinc-800 overflow-hidden self-start">
          <div className="border-b border-zinc-800 px-5 py-3 text-sm font-medium text-zinc-400">
            Audit trail
          </div>
          <ul className="divide-y divide-zinc-900">
            {activity.map((a) => (
              <li key={a.id} className="px-5 py-3">
                <div className="flex items-start gap-3">
                  <span className="mt-0.5 text-zinc-500">
                    {KIND_ICONS[a.kind] ?? "·"}
                  </span>
                  <div className="min-w-0">
                    <p className="text-sm text-zinc-200">{a.summary}</p>
                    <p className="text-xs text-zinc-500">
                      {new Date(a.ts).toLocaleString()}
                      {typeof a.detail.explorer === "string" && (
                        <>
                          {" · "}
                          <a
                            href={a.detail.explorer}
                            target="_blank"
                            className="text-sky-400 hover:underline"
                          >
                            explorer ↗
                          </a>
                        </>
                      )}
                    </p>
                  </div>
                </div>
              </li>
            ))}
            {activity.length === 0 && (
              <li className="px-5 py-8 text-center text-sm text-zinc-600">
                No activity yet.
              </li>
            )}
          </ul>
        </section>
      </main>
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-zinc-800 p-5">
      <div className="text-xs uppercase tracking-wide text-zinc-500">
        {label}
      </div>
      <div className="mt-1 text-2xl font-semibold">{value}</div>
    </div>
  );
}
