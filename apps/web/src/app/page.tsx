"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  api,
  formatUsdc,
  type ActivityRow,
  type InvoiceRow,
  type Payee,
  type TickResult,
  type TreasuryState,
} from "@/lib/api";

const STATUS_STYLES: Record<string, { bg: string; ink: string; label: string }> = {
  pending: { bg: "bg-field-sunken", ink: "text-ink-soft", label: "pending" },
  paid: { bg: "bg-paid-bg", ink: "text-paid", label: "paid" },
  awaiting_approval: { bg: "bg-hold-bg", ink: "text-hold", label: "awaiting approval" },
  flagged: { bg: "bg-flag-bg", ink: "text-flag", label: "flagged" },
  rejected: { bg: "bg-alert-bg", ink: "text-alert", label: "rejected" },
};

const KIND_DOTS: Record<string, string> = {
  payee_onboarded: "bg-brass",
  invoice_paid: "bg-paid",
  intent_proposed: "bg-hold",
  policy_denied: "bg-alert",
  anomaly_flagged: "bg-flag",
  x402_purchase: "bg-brass",
  petty_cash_topup: "bg-brass",
  cross_chain_payout: "bg-hold",
  agent_note: "bg-ink-faint",
};

function shortAddr(a: string) {
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

export default function Dashboard() {
  const [invoices, setInvoices] = useState<InvoiceRow[]>([]);
  const [activity, setActivity] = useState<ActivityRow[]>([]);
  const [treasury, setTreasury] = useState<TreasuryState | null>(null);
  const [tick, setTick] = useState<TickResult | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [approving, setApproving] = useState<string | null>(null);

  const decide = async (invoiceId: string, action: "approve" | "reject") => {
    setApproving(invoiceId);
    try {
      await (action === "approve" ? api.approve(invoiceId) : api.reject(invoiceId));
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setApproving(null);
    }
  };

  const refresh = useCallback(async () => {
    try {
      const [inv, act, tre] = await Promise.all([
        api.invoices(),
        api.activity(),
        api.treasury().catch(() => null),
      ]);
      setInvoices(inv);
      setActivity(act);
      setTreasury(tre);
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
  const awaiting = invoices.filter((i) => i.invoices.status === "awaiting_approval");
  const pendingTotal = pending
    .reduce((s, i) => s + BigInt(i.invoices.amountBaseUnits), 0n)
    .toString();

  return (
    <div className="mx-auto w-full max-w-6xl px-6 pb-16">
      {/* Masthead */}
      <header className="flex flex-wrap items-end justify-between gap-4 border-b-2 border-ink pb-4 pt-8">
        <div>
          <h1 className="font-display text-4xl italic tracking-tight">AutoCFO</h1>
          <p className="micro-label mt-1">
            Autonomous treasury · mandate enforced by policy, not prompt
          </p>
        </div>
        <button
          onClick={runTick}
          disabled={running}
          className="border border-ink bg-ink px-4 py-2 text-sm font-medium text-field transition hover:bg-ink/85 disabled:opacity-40"
        >
          {running ? "Working…" : "Run tick"}
        </button>
      </header>

      {error && (
        <div className="mt-4 border border-alert bg-alert-bg px-4 py-2 text-sm text-alert">
          {error} — is the agent service running on :3001?
        </div>
      )}

      {/* Balance strip */}
      <section className="mt-6 grid grid-cols-2 gap-px border border-line bg-line md:grid-cols-4">
        <Stat
          label="Treasury · Arc"
          value={
            treasury?.treasury ? `$${treasury.treasury.usdcBalance}` : "—"
          }
          sub={
            treasury?.treasury ? shortAddr(treasury.treasury.address) : "not configured"
          }
        />
        <Stat
          label="Petty cash · Gateway"
          value={
            treasury?.pettyCash?.balances?.gateway?.formattedAvailable
              ? `$${treasury.pettyCash.balances.gateway.formattedAvailable}`
              : "—"
          }
          sub={
            treasury?.pettyCash ? shortAddr(treasury.pettyCash.address) : "not configured"
          }
        />
        <Stat
          label="Pending outflow"
          value={`$${formatUsdc(pendingTotal)}`}
          sub={`${pending.length} invoice${pending.length === 1 ? "" : "s"}`}
        />
        <Stat
          label="Awaiting approval"
          value={String(awaiting.length)}
          sub={awaiting.length ? "action required" : "all clear"}
          accent={awaiting.length > 0}
        />
      </section>

      <main className="mt-8 grid grid-cols-1 gap-10 lg:grid-cols-[1fr_320px]">
        <section>
          {/* Ledger */}
          <div className="flex items-baseline justify-between">
            <h2 className="font-display text-xl">Ledger</h2>
            <NewInvoice onCreated={refresh} />
          </div>
          <table className="mt-3 w-full border-t border-ink text-sm">
            <thead>
              <tr className="border-b border-line text-left">
                <th className="micro-label py-2 font-normal">Payee</th>
                <th className="micro-label py-2 text-right font-normal">Amount</th>
                <th className="micro-label py-2 pl-6 font-normal">Due</th>
                <th className="micro-label py-2 pl-6 text-right font-normal">Status</th>
              </tr>
            </thead>
            <tbody>
              {invoices.map((row) => {
                const s = STATUS_STYLES[row.invoices.status];
                return (
                  <tr key={row.invoices.id} className="border-b border-line align-top">
                    <td className="py-3 pr-4">
                      <div className="font-medium">{row.payees.name}</div>
                      <div className="mt-0.5 text-xs text-ink-soft">
                        {row.invoices.memo}
                        {row.payees.ensName && (
                          <span className="font-ledger ml-2 text-brass-ink">
                            {row.payees.ensName}
                          </span>
                        )}
                        {row.payees.preferredChain !== "arc-testnet" && (
                          <span className="ml-2 text-brass-ink">
                            ⇄ {row.payees.preferredChain}
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="font-ledger py-3 text-right">
                      {formatUsdc(row.invoices.amountBaseUnits)}
                    </td>
                    <td className="font-ledger py-3 pl-6 text-xs text-ink-soft">
                      {new Date(row.invoices.dueDate).toLocaleDateString(undefined, {
                        month: "short",
                        day: "numeric",
                      })}
                    </td>
                    <td className="py-3 pl-6 text-right">
                      {row.invoices.status === "awaiting_approval" ? (
                        <span className="inline-flex items-center gap-1.5">
                          <button
                            disabled={approving === row.invoices.id}
                            onClick={() => decide(row.invoices.id, "approve")}
                            className="border border-paid bg-paid-bg px-2 py-0.5 text-xs text-paid transition hover:bg-paid hover:text-field disabled:opacity-40"
                          >
                            {approving === row.invoices.id ? "signing…" : "approve"}
                          </button>
                          <button
                            disabled={approving === row.invoices.id}
                            onClick={() => decide(row.invoices.id, "reject")}
                            className="border border-alert bg-alert-bg px-2 py-0.5 text-xs text-alert transition hover:bg-alert hover:text-field disabled:opacity-40"
                          >
                            reject
                          </button>
                        </span>
                      ) : row.invoices.txHash ? (
                        <a
                          href={`https://testnet.arcscan.app/tx/${row.invoices.txHash}`}
                          target="_blank"
                          className={`inline-block px-2 py-0.5 text-xs ${s.bg} ${s.ink} underline decoration-dotted underline-offset-2`}
                        >
                          {s.label} ↗
                        </a>
                      ) : (
                        <span className={`inline-block px-2 py-0.5 text-xs ${s.bg} ${s.ink}`}>
                          {s.label}
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
              {invoices.length === 0 && (
                <tr>
                  <td colSpan={4} className="py-10 text-center text-sm text-ink-faint">
                    Ledger empty — run the seed script.
                  </td>
                </tr>
              )}
            </tbody>
          </table>

          {/* Agent memo (from Run tick) */}
          {tick && (
            <div className="mt-8 border-l-2 border-brass bg-field-raised p-5">
              <div className="micro-label">Memo from the CFO agent</div>
              <p className="mt-2 whitespace-pre-wrap font-display text-[15px] leading-relaxed">
                {tick.summary}
              </p>
              {tick.steps.length > 0 && (
                <div className="font-ledger mt-3 text-[11px] text-ink-faint">
                  {tick.steps
                    .flatMap((s) => s.toolCalls.map((c) => c.tool))
                    .join(" → ")}
                </div>
              )}
            </div>
          )}

          <Chat onActed={refresh} />
        </section>

        {/* Audit trail */}
        <aside>
          <div className="flex items-baseline justify-between">
            <h2 className="font-display text-xl">Audit trail</h2>
            <span className="micro-label">signal → action</span>
          </div>
          <ul className="mt-3 border-t border-ink">
            {activity.map((a) => (
              <li key={a.id} className="border-b border-line py-3">
                <div className="flex items-start gap-2.5">
                  <span
                    className={`mt-1.5 block h-2 w-2 shrink-0 rounded-full ${KIND_DOTS[a.kind] ?? "bg-ink-faint"}`}
                  />
                  <div className="min-w-0">
                    <p className="text-[13px] leading-snug">{a.summary}</p>
                    <p className="font-ledger mt-1 text-[11px] text-ink-faint">
                      {new Date(a.ts).toLocaleTimeString(undefined, {
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                      {typeof a.detail.explorer === "string" && (
                        <>
                          {" · "}
                          <a
                            href={a.detail.explorer}
                            target="_blank"
                            className="text-brass-ink underline decoration-dotted underline-offset-2"
                          >
                            proof ↗
                          </a>
                        </>
                      )}
                    </p>
                  </div>
                </div>
              </li>
            ))}
            {activity.length === 0 && (
              <li className="py-10 text-center text-sm text-ink-faint">
                Nothing yet — the agent writes here as it works.
              </li>
            )}
          </ul>
        </aside>
      </main>

      <footer className="micro-label mt-12 border-t border-line pt-4">
        Mandate: allowlisted payees · per-tx cap · daily budget — enforced by
        Privy policies in a TEE. Over-mandate spend requires human MFA approval.
      </footer>
    </div>
  );
}

interface ChatMsg {
  role: "user" | "agent";
  text: string;
  tools?: string[];
}

function Chat({ onActed }: { onActed: () => Promise<void> }) {
  const [msgs, setMsgs] = useState<ChatMsg[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [msgs, busy]);

  const send = async () => {
    const text = draft.trim();
    if (!text || busy) return;
    setDraft("");
    setMsgs((m) => [...m, { role: "user", text }]);
    setBusy(true);
    try {
      const { reply, toolsUsed } = await api.chat(text);
      setMsgs((m) => [...m, { role: "agent", text: reply, tools: toolsUsed }]);
      await onActed();
    } catch (e) {
      setMsgs((m) => [
        ...m,
        { role: "agent", text: `⚠ ${e instanceof Error ? e.message : String(e)}` },
      ]);
    } finally {
      setBusy(false);
    }
  };

  const clear = async () => {
    await api.chatReset().catch(() => {});
    setMsgs([]);
  };

  return (
    <div className="mt-8 border border-line bg-field-raised">
      <div className="flex items-center justify-between border-b border-line px-4 py-2.5">
        <span className="micro-label">Talk to your CFO</span>
        {msgs.length > 0 && (
          <button onClick={clear} className="micro-label hover:text-ink">
            clear
          </button>
        )}
      </div>
      <div className="max-h-96 space-y-4 overflow-y-auto px-4 py-4">
        {msgs.length === 0 && (
          <p className="text-sm text-ink-faint">
            Try: “onboard a new payee called karan with address 0x… and pay him
            8 USDC each month” — the agent will ask you before granting payment
            authority.
          </p>
        )}
        {msgs.map((m, i) =>
          m.role === "user" ? (
            <div key={i} className="flex justify-end">
              <div className="max-w-[85%] border border-line-strong bg-field-sunken px-3 py-2 text-sm">
                {m.text}
              </div>
            </div>
          ) : (
            <div key={i} className="max-w-[92%] border-l-2 border-brass pl-3">
              <p className="whitespace-pre-wrap text-sm leading-relaxed">{m.text}</p>
              {m.tools && m.tools.length > 0 && (
                <p className="font-ledger mt-1 text-[11px] text-ink-faint">
                  {m.tools.join(" → ")}
                </p>
              )}
            </div>
          ),
        )}
        {busy && (
          <div className="border-l-2 border-line pl-3 text-sm text-ink-faint">
            thinking…
          </div>
        )}
        <div ref={endRef} />
      </div>
      <div className="flex gap-2 border-t border-line p-3">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && send()}
          placeholder="Message the CFO…"
          disabled={busy}
          className="flex-1 border border-line-strong bg-field px-3 py-2 text-sm placeholder:text-ink-faint focus:border-ink focus:outline-none disabled:opacity-50"
        />
        <button
          onClick={send}
          disabled={busy || !draft.trim()}
          className="border border-ink bg-ink px-4 py-2 text-sm text-field transition hover:bg-ink/85 disabled:opacity-40"
        >
          send
        </button>
      </div>
    </div>
  );
}

function NewInvoice({ onCreated }: { onCreated: () => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [payees, setPayees] = useState<Payee[]>([]);
  const [payeeId, setPayeeId] = useState("");
  const [amount, setAmount] = useState("");
  const [memo, setMemo] = useState("");
  const [dueInDays, setDueInDays] = useState("0");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      api.payees().then((p) => {
        setPayees(p);
        if (p.length && !payeeId) setPayeeId(p[0].id);
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const submit = async () => {
    if (!payeeId || !amount || !memo) {
      setErr("all fields required");
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      await api.createInvoice({
        payeeId,
        amountUsdc: amount,
        memo,
        dueInDays: Number(dueInDays),
      });
      setAmount("");
      setMemo("");
      setOpen(false);
      await onCreated();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="micro-label border border-line-strong px-2.5 py-1 transition hover:border-ink hover:text-ink"
      >
        + new invoice
      </button>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <select
        value={payeeId}
        onChange={(e) => setPayeeId(e.target.value)}
        className="border border-line-strong bg-field-raised px-2 py-1 text-xs focus:border-ink focus:outline-none"
      >
        {payees.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>
      <input
        value={amount}
        onChange={(e) => setAmount(e.target.value)}
        placeholder="USDC"
        className="font-ledger w-20 border border-line-strong bg-field-raised px-2 py-1 text-xs focus:border-ink focus:outline-none"
      />
      <input
        value={memo}
        onChange={(e) => setMemo(e.target.value)}
        placeholder="memo"
        className="w-40 border border-line-strong bg-field-raised px-2 py-1 text-xs focus:border-ink focus:outline-none"
      />
      <select
        value={dueInDays}
        onChange={(e) => setDueInDays(e.target.value)}
        className="border border-line-strong bg-field-raised px-2 py-1 text-xs focus:border-ink focus:outline-none"
      >
        <option value="-1">overdue</option>
        <option value="0">due today</option>
        <option value="3">due in 3d</option>
        <option value="14">due in 14d</option>
      </select>
      <button
        onClick={submit}
        disabled={busy}
        className="border border-ink bg-ink px-2.5 py-1 text-xs text-field transition hover:bg-ink/85 disabled:opacity-40"
      >
        {busy ? "adding…" : "add"}
      </button>
      <button
        onClick={() => setOpen(false)}
        className="px-1 text-xs text-ink-faint hover:text-ink"
      >
        ✕
      </button>
      {err && <span className="text-xs text-alert">{err}</span>}
    </div>
  );
}

function Stat({
  label,
  value,
  sub,
  accent,
}: {
  label: string;
  value: string;
  sub?: string;
  accent?: boolean;
}) {
  return (
    <div className="bg-field p-4">
      <div className="micro-label">{label}</div>
      <div
        className={`font-ledger mt-1.5 text-2xl ${accent ? "text-brass-ink" : ""}`}
      >
        {value}
      </div>
      {sub && <div className="font-ledger mt-0.5 text-[11px] text-ink-faint">{sub}</div>}
    </div>
  );
}
