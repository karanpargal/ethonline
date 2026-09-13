"use client";

import Image from "next/image";
import { useCallback, useEffect, useRef, useState } from "react";
import { usePrivy } from "@privy-io/react-auth";
import { PRIVY_ENABLED } from "./providers";
import logoMark from "./icon.png";
import {
  api,
  clearToken,
  formatUsdc,
  getToken,
  setToken,
  UnauthorizedError,
  type OnboardResult,
  type ActivityRow,
  type InvoiceRow,
  type Payee,
  type TickResult,
  type TreasuryState,
} from "@/lib/api";

type Me = Awaited<ReturnType<typeof api.me>>;

const STATUS_STYLES: Record<string, { chip: string; label: string }> = {
  pending: { chip: "chip-neutral", label: "Pending" },
  paid: { chip: "chip-paid", label: "Paid" },
  awaiting_approval: { chip: "chip-wait", label: "Awaiting approval" },
  flagged: { chip: "chip-flag", label: "Flagged" },
  rejected: { chip: "chip-stop", label: "Rejected" },
};

// Same colour language as the ledger: green = money moved, amber = needs a
// person, red = refused, blue = setup.
const KIND_DOTS: Record<string, string> = {
  payee_onboarded: "bg-signal",
  invoice_paid: "bg-paid",
  intent_proposed: "bg-wait",
  policy_denied: "bg-stop",
  anomaly_flagged: "bg-wait",
  x402_purchase: "bg-paid",
  petty_cash_topup: "bg-paid",
  cross_chain_payout: "bg-paid",
  agent_note: "bg-ink-quiet",
};

const ICONS = {
  play: <path d="M5.5 3.8v8.4a.6.6 0 0 0 .9.5l6.7-4.2a.6.6 0 0 0 0-1L6.4 3.3a.6.6 0 0 0-.9.5z" fill="currentColor" />,
  plus: <path d="M8 3.25v9.5M3.25 8h9.5" />,
  repeat: (
    <>
      <path d="M2.75 7.25v-.5a2.5 2.5 0 0 1 2.5-2.5h7.5" />
      <path d="m10.75 2.25 2 2-2 2" />
      <path d="M13.25 8.75v.5a2.5 2.5 0 0 1-2.5 2.5h-7.5" />
      <path d="m5.25 13.75-2-2 2-2" />
    </>
  ),
  check: <path d="m3.5 8.5 3 3 6-7" />,
  arrowUp: <path d="M8 12.75v-9.5M3.75 7.5 8 3.25l4.25 4.25" />,
  shield: <path d="M8 1.75 2.75 3.6v3.9c0 3 2.1 5.5 5.25 6.75 3.15-1.25 5.25-3.75 5.25-6.75V3.6z" />,
  calendar: (
    <>
      <rect x="2.25" y="3.25" width="11.5" height="10.5" rx="2" />
      <path d="M2.25 6.75h11.5M5.5 1.75v3M10.5 1.75v3" />
    </>
  ),
  listCheck: (
    <>
      <path d="m2.25 4.5 1.25 1.25 2.25-2.5" />
      <path d="m2.25 10.75 1.25 1.25 2.25-2.5" />
      <path d="M8.25 4.75h5.5M8.25 11h5.5" />
    </>
  ),
};

function Icon({ name }: { name: keyof typeof ICONS }) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {ICONS[name]}
    </svg>
  );
}

function shortAddr(a: string) {
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

function shortDate(d: string | number | Date) {
  return new Date(d).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

// USDC has 6 decimals. Lead with dollars and cents; keep the sub-cent digits
// visible but quiet rather than rounding real money away.
function Money({ value }: { value: string }) {
  const [whole, frac = ""] = value.split(".");
  const cents = frac.slice(0, 2).padEnd(2, "0");
  const rest = frac.slice(2).replace(/0+$/, "");
  return (
    <>
      ${whole}.{cents}
      {rest && <span className="text-[0.42em] font-normal tracking-normal opacity-55">{rest}</span>}
    </>
  );
}

function Wordmark({
  className = "text-[20px]",
  dotClassName = "text-sky",
}: {
  className?: string;
  dotClassName?: string;
}) {
  return (
    <span className={`font-bold tracking-[-0.03em] ${className}`}>
      autocfo<span className={dotClassName}>.</span>
    </span>
  );
}

function SectionHeader({
  title,
  note,
  right,
}: {
  title: string;
  note?: string;
  right?: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
      <div>
        <h2 className="text-[22px] font-medium tracking-[-0.015em]">{title}</h2>
        {note && <p className="mt-1 text-[14px] text-ink-muted">{note}</p>}
      </div>
      {right}
    </div>
  );
}

// Agent replies use light markdown; render **bold** and `code`, nothing more.
function Rich({ text }: { text: string }) {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
  return (
    <>
      {parts.map((p, i) =>
        p.startsWith("**") && p.endsWith("**") ? (
          <strong key={i} className="font-semibold">
            {p.slice(2, -2)}
          </strong>
        ) : p.startsWith("`") && p.endsWith("`") ? (
          <code key={i} className="mono">
            {p.slice(1, -1)}
          </code>
        ) : (
          p
        ),
      )}
    </>
  );
}

export default function Dashboard() {
  const [invoices, setInvoices] = useState<InvoiceRow[]>([]);
  const [activity, setActivity] = useState<ActivityRow[]>([]);
  const [treasury, setTreasury] = useState<TreasuryState | null>(null);
  const [tick, setTick] = useState<TickResult | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recurringRows, setRecurringRows] = useState<
    Awaited<ReturnType<typeof api.recurring>>
  >([]);
  const [needsOnboarding, setNeedsOnboarding] = useState(false);
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [showProfile, setShowProfile] = useState(false);
  const [me, setMe] = useState<Me | null>(null);
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
        api.treasury().catch((e) => {
          if (e instanceof UnauthorizedError) throw e;
          return null;
        }),
      ]);
      setInvoices(inv);
      setActivity(act);
      setTreasury(tre);
      api.recurring().then(setRecurringRows).catch(() => {});
      setError(null);
      setNeedsOnboarding(false);
    } catch (e) {
      if (e instanceof UnauthorizedError) {
        setNeedsOnboarding(true);
        return;
      }
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    if (needsOnboarding || showOnboarding) return;
    api.me().then(setMe).catch(() => {});
  }, [needsOnboarding, showOnboarding]);

  useEffect(() => {
    if (needsOnboarding || showOnboarding) return; // no polling on the gate
    refresh();
    const t = setInterval(refresh, 5000);
    return () => clearInterval(t);
  }, [refresh, needsOnboarding, showOnboarding]);

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

  if (needsOnboarding || showOnboarding) {
    return (
      <Onboarding
        onDone={async () => {
          setShowOnboarding(false);
          setMe(null);
          await refresh();
        }}
        onCancel={needsOnboarding ? undefined : () => setShowOnboarding(false)}
      />
    );
  }

  const pending = invoices.filter((i) => i.invoices.status === "pending");
  const awaiting = invoices.filter((i) => i.invoices.status === "awaiting_approval");
  const pendingTotal = pending
    .reduce((s, i) => s + BigInt(i.invoices.amountBaseUnits), 0n)
    .toString();

  const freshOrg =
    invoices.length === 0 &&
    activity.length === 0 &&
    (treasury?.treasury?.usdcBalance ?? "0") === "0";

  const title = me?.name ? me.name.replace(/\.$/, "") : "Your treasury";
  const statusLine = error
    ? "The latest numbers couldn't be loaded."
    : awaiting.length > 0
      ? `${awaiting.length} payment${awaiting.length === 1 ? " is" : "s are"} waiting for your approval.`
      : freshOrg
        ? "Fund the treasury to get started."
        : pending.length > 0
          ? `${pending.length} unpaid bill${pending.length === 1 ? "" : "s"} on the ledger.`
          : "Every bill is settled.";

  const petty = treasury?.pettyCash;

  return (
    <>
      <div className="mx-auto w-full max-w-[1200px] flex-1 px-4 sm:px-6 md:px-10">
        <header className="pt-5">
          <nav className="flex flex-wrap items-center justify-between gap-3 rounded-[28px] bg-mist py-2 pl-6 pr-2 sm:rounded-full">
            <div className="flex min-w-0 items-center gap-3">
              <span className="flex shrink-0 items-center gap-2">
                <Image src={logoMark} alt="" width={32} height={32} priority className="size-8" />
                <Wordmark />
              </span>
              {/* {me && <span className="truncate text-[14px] text-ink-muted">{me.name}</span>} */}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {getToken() ? (
                PRIVY_ENABLED ? (
                  <PrivySignOutButton />
                ) : (
                  <button
                    onClick={() => {
                      clearToken();
                      location.reload();
                    }}
                    className="btn btn-secondary"
                  >
                    Sign out
                  </button>
                )
              ) : (
                <button onClick={() => setShowOnboarding(true)} className="btn btn-secondary">
                  <Icon name="plus" />
                  Create your org
                </button>
              )}
              <button onClick={runTick} disabled={running} className="btn btn-primary">
                <Icon name="play" />
                {running ? "Working…" : "Run tick"}
              </button>
            </div>
          </nav>
        </header>

        {showProfile && <Profile onClose={() => setShowProfile(false)} />}

        <section className="mt-14 md:mt-20">
          <h1 className="max-w-[30ch] text-[34px] font-medium leading-[1.08] tracking-[-0.035em] md:text-[52px]">
            <span className="block">{title}.</span>
            <span className="block text-ink-quiet">{statusLine}</span>
          </h1>
          {me && (
            <div className="mt-7 flex flex-wrap items-center gap-2">
              {/* <span className="mr-1 text-[13px] text-ink-muted">Mandate</span> */}
              <ul className="contents" aria-label="Mandate">
                <li className="badge">
                  <Icon name="shield" />
                  <span>
                    Up to <strong className="num">${me.perTxCapUsdc}</strong> per payment
                  </span>
                </li>
                <li className="badge">
                  <Icon name="calendar" />
                  <span>
                    <strong className="num">${me.dailyCapUsdc}</strong> daily budget
                  </span>
                </li>
                <li className="badge">
                  <Icon name="listCheck" />
                  <span>Allowlisted payees only</span>
                </li>
              </ul>
            </div>
          )}
        </section>

        {error && (
          <div role="alert" className="mt-8 rounded-2xl bg-stop-wash px-5 py-3.5 text-[14px] text-stop">
            {error}
            {/fetch/i.test(error) && " Check that the agent service is running on port 3001."}
          </div>
        )}

        <section
          aria-label="Balances"
          className="mt-10 grid grid-cols-1 gap-3 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]"
        >
          <TreasuryCard treasury={treasury} onChanged={refresh} />
          <div className="grid grid-cols-1 divide-y divide-line rounded-3xl bg-mist p-2 sm:grid-cols-3 sm:divide-x sm:divide-y-0">
            <Figure
              label="Petty cash"
              value={
                petty?.balances?.gateway?.formattedAvailable ? (
                  <Money value={petty.balances.gateway.formattedAvailable} />
                ) : (
                  "—"
                )
              }
              sub={petty ? <span className="mono">{shortAddr(petty.address)}</span> : "Not configured"}
              copy={petty?.address}
            />
            <Figure
              label="Pending outflow"
              value={`$${formatUsdc(pendingTotal)}`}
              sub={
                <>
                  <span className="num">{pending.length}</span> invoice
                  {pending.length === 1 ? "" : "s"}
                </>
              }
            />
            <Figure
              label="Awaiting approval"
              value={String(awaiting.length)}
              sub={awaiting.length ? "Action required" : "All clear"}
              wait={awaiting.length > 0}
            />
          </div>
        </section>

        <main className="mt-16 grid grid-cols-1 gap-14 lg:grid-cols-[minmax(0,1fr)_380px]">
          <div className="min-w-0 space-y-16">
            {freshOrg && (
              <section className="rounded-3xl border border-line p-6 md:p-7">
                <h2 className="text-[18px] font-medium">Getting started</h2>
                <ol className="mt-5 space-y-4 text-[15px] leading-relaxed">
                  <Step n={1}>
                    Fund your treasury with Arc testnet USDC at{" "}
                    <a href="https://faucet.circle.com" target="_blank" rel="noreferrer" className="link">
                      faucet.circle.com ↗
                    </a>
                    . Copy the address from the treasury card above.
                  </Step>
                  <Step n={2}>
                    In chat, onboard your first payee. The agent registers their ENS name and asks
                    you to confirm a payment cap.
                  </Step>
                  <Step n={3}>
                    Add a bill with <span className="font-medium">New invoice</span>, then{" "}
                    <span className="font-medium">Run tick</span>. Bills inside your mandate are paid
                    on-chain; anything over your caps comes back to you for approval.
                  </Step>
                </ol>
              </section>
            )}

            <section id="ledger" className="scroll-mt-6">
              <SectionHeader
                title="Ledger"
                note="Bills the agent pays when they're due."
                right={
                  <div className="flex flex-wrap items-center justify-end gap-2">
                    <NewRecurring onCreated={refresh} />
                    <NewInvoice onCreated={refresh} />
                  </div>
                }
              />
              <div className="mt-6 overflow-x-auto">
                <table className="w-full min-w-[560px] text-[15px]">
                  <thead>
                    <tr className="border-b border-line text-left text-[13px] text-ink-muted">
                      <th scope="col" className="pb-3 font-normal">Payee</th>
                      <th scope="col" className="pb-3 pl-6 font-normal">Due</th>
                      <th scope="col" className="pb-3 pl-6 text-right font-normal">Amount</th>
                      <th scope="col" className="pb-3 pl-6 text-right font-normal">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {invoices.map((row) => {
                      const s = STATUS_STYLES[row.invoices.status] ?? STATUS_STYLES.pending;
                      const id = row.invoices.id;
                      return (
                        <tr key={id} className="border-b border-line align-top last:border-0">
                          <td className="py-4 pr-4">
                            <div className="font-medium">{row.payees.name}</div>
                            <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[13px] text-ink-muted">
                              <span>{row.invoices.memo}</span>
                              {row.payees.ensName && <span>{row.payees.ensName}</span>}
                              {row.payees.preferredChain !== "arc-testnet" && (
                                <span>Paid out on {row.payees.preferredChain}</span>
                              )}
                            </div>
                          </td>
                          <td className="num whitespace-nowrap py-4 pl-6 text-ink-muted">
                            {shortDate(row.invoices.dueDate)}
                          </td>
                          <td className="num whitespace-nowrap py-4 pl-6 text-right font-semibold">
                            ${formatUsdc(row.invoices.amountBaseUnits)}
                          </td>
                          <td className="whitespace-nowrap py-3 pl-6 text-right">
                            {row.invoices.status === "awaiting_approval" ? (
                              <span className="inline-flex items-center gap-1">
                                <button
                                  disabled={approving === id}
                                  onClick={() => decide(id, "approve")}
                                  className="btn btn-primary btn-sm"
                                >
                                  <Icon name="check" />
                                  {approving === id ? "Signing…" : "Approve"}
                                </button>
                                <button
                                  disabled={approving === id}
                                  onClick={() => decide(id, "reject")}
                                  className="btn btn-quiet btn-sm"
                                >
                                  Reject
                                </button>
                              </span>
                            ) : row.invoices.txHash ? (
                              <a
                                href={`https://testnet.arcscan.app/tx/${row.invoices.txHash}`}
                                target="_blank"
                                rel="noreferrer"
                                className={`chip ${s.chip} mt-1 hover:underline`}
                              >
                                {s.label} ↗
                              </a>
                            ) : (
                              <span className={`chip ${s.chip} mt-1`}>{s.label}</span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                    {invoices.length === 0 && (
                      <tr>
                        <td colSpan={4} className="py-12 text-center text-[15px] text-ink-muted">
                          No invoices yet. Add one with{" "}
                          <span className="font-medium text-ink">New invoice</span>, or ask your CFO to
                          set up a recurring payment.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>

              {recurringRows.length > 0 && (
                <div className="mt-10">
                  <h3 className="text-[15px] font-medium">Standing orders</h3>
                  <ul className="mt-2">
                    {recurringRows.map((r) => (
                      <li
                        key={r.id}
                        className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 border-b border-line py-3 text-[14px] last:border-0"
                      >
                        <span className="flex gap-2">
                          <span className="font-medium">{r.payeeName}</span>
                          <span className="text-ink-muted">{r.memo}</span>
                        </span>
                        <span className="text-ink-muted">
                          <span className="num font-semibold text-ink">${r.amountUsdc}</span> every{" "}
                          <span className="num">{r.intervalDays}</span> days, next{" "}
                          <span className="num">{shortDate(r.nextDue)}</span>
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {tick && (
                <div className="mt-10 rounded-3xl bg-mist p-6 md:p-7">
                  <h3 className="text-[15px] font-medium">Memo from your CFO</h3>
                  <p className="mt-3 max-w-[68ch] whitespace-pre-wrap text-[15px] leading-relaxed">
                    <Rich text={tick.summary} />
                  </p>
                  {tick.steps.length > 0 && (
                    <p className="mono mt-4 text-[12px] text-ink-muted">
                      {tick.steps.flatMap((st) => st.toolCalls.map((tc) => tc.tool)).join(" → ")}
                    </p>
                  )}
                </div>
              )}
            </section>

            <section>
              <SectionHeader
                title="Audit trail"
                note="Every decision the agent makes, with on-chain proof."
              />
              <ul className="mt-6 border-t border-line">
                {activity.map((a) => (
                  <li key={a.id} className="flex gap-3.5 border-b border-line py-4 last:border-0">
                    <span
                      aria-hidden
                      className={`mt-[7px] size-2 shrink-0 rounded-full ${KIND_DOTS[a.kind] ?? "bg-ink-quiet"}`}
                    />
                    <div className="min-w-0 flex-1">
                      <p className="text-[15px] leading-snug">{a.summary}</p>
                      <p className="mt-1 flex gap-3 text-[13px] text-ink-muted">
                        <span className="num">
                          {new Date(a.ts).toLocaleTimeString(undefined, {
                            hour: "2-digit",
                            minute: "2-digit",
                          })}
                        </span>
                        {typeof a.detail.explorer === "string" && (
                          <a href={a.detail.explorer} target="_blank" rel="noreferrer" className="link">
                            Proof ↗
                          </a>
                        )}
                      </p>
                    </div>
                  </li>
                ))}
                {activity.length === 0 && (
                  <li className="py-12 text-center text-[15px] text-ink-muted">
                    Nothing yet. The agent records every action here as it works.
                  </li>
                )}
              </ul>
            </section>
          </div>

          <aside className="lg:sticky lg:top-6 lg:self-start">
            <SectionHeader title="Your CFO" note="Asks before it grants payment authority." />
            <div className="mt-6">
              <Chat onActed={refresh} />
            </div>
          </aside>
        </main>
      </div>
      <SiteFooter
        treasuryAddress={me?.treasuryAddress}
        onOpenProfile={() => setShowProfile(true)}
      />
    </>
  );
}

// One ribbon of evenly offset curves flowing in a single direction behind the
// footer, strongest through the middle and fading toward its edges.
const FOOTER_CURVE_COUNT = 10;
const FOOTER_CURVES = Array.from({ length: FOOTER_CURVE_COUNT }, (_, i) => ({
  d: `M-120 ${450 - i * 26} C 300 ${160 - i * 26}, 860 ${620 - i * 30}, 1580 ${120 - i * 15}`,
  opacity: 0.35 + 0.65 * Math.sin((Math.PI * i) / (FOOTER_CURVE_COUNT - 1)),
}));

function SiteFooter({
  treasuryAddress,
  onOpenProfile,
}: {
  treasuryAddress?: string;
  onOpenProfile: () => void;
}) {
  return (
    <footer className="relative mx-4 mb-4 mt-28 overflow-hidden rounded-[32px] bg-frost md:mx-6 md:mb-6">
      <svg
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 h-full w-full text-frost-line"
        viewBox="0 0 1440 440"
        preserveAspectRatio="xMidYMid slice"
        fill="none"
      >
        {FOOTER_CURVES.map((c, i) => (
          <path
            key={i}
            d={c.d}
            stroke="currentColor"
            strokeWidth="2.5"
            strokeOpacity={c.opacity}
            vectorEffect="non-scaling-stroke"
          />
        ))}
      </svg>
      <div className="relative mx-auto w-full max-w-[1200px] px-6 md:px-10">
        <div className="grid grid-cols-1 gap-12 pb-14 pt-16 md:grid-cols-[minmax(0,1fr)_auto] md:gap-20">
          <div>
            <Wordmark className="text-[44px] leading-none md:text-[56px]" dotClassName="text-signal" />
            <p className="mt-4 text-[17px]">Bills paid on time, inside limits you set.</p>
            <p className="mt-3 max-w-[56ch] text-[13px] leading-relaxed text-ink-muted">
              Payments only go to allowlisted payees, within per-payment caps enforced by Privy
              policies inside a secure enclave, and within your daily budget. Anything over the
              mandate waits for your approval.
            </p>
          </div>
          <nav aria-label="Footer" className="grid grid-cols-2 gap-x-16 text-[15px] md:pt-2">
            <ul className="space-y-4">
              <li>
                <a href="#ledger" className="footer-link">Ledger</a>
              </li>
              <li>
                <button onClick={onOpenProfile} className="footer-link cursor-pointer">
                  Company profile
                </button>
              </li>
            </ul>
            <ul className="space-y-4">
              <li>
                <a
                  href={
                    treasuryAddress
                      ? `https://testnet.arcscan.app/address/${treasuryAddress}`
                      : "https://testnet.arcscan.app"
                  }
                  target="_blank"
                  rel="noreferrer"
                  className="footer-link"
                >
                  Treasury on Arcscan ↗
                </a>
              </li>
              <li>
                <a href="https://faucet.circle.com" target="_blank" rel="noreferrer" className="footer-link">
                  Testnet USDC faucet ↗
                </a>
              </li>
            </ul>
          </nav>
        </div>
      </div>
      <div className="relative bg-deep">
        <div className="mx-auto flex w-full max-w-[1200px] flex-wrap items-center justify-between gap-x-6 gap-y-1 px-6 py-4 text-[13px] text-deep-muted md:px-10">
          <span>
            Copyright © <span className="num">{new Date().getFullYear()}</span> AutoCFO
          </span>
          <span>Built for ETHOnline 2026 on Arc testnet</span>
        </div>
      </div>
    </footer>
  );
}

function TreasuryCard({
  treasury,
  onChanged,
}: {
  treasury: TreasuryState | null;
  onChanged: () => Promise<void>;
}) {
  const t = treasury?.treasury;
  const [open, setOpen] = useState(false);
  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const withdraw = async () => {
    setBusy(true);
    setErr(null);
    try {
      await api.withdraw(to.trim(), amount.trim());
      setOpen(false);
      setTo("");
      setAmount("");
      await onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-48 flex-col justify-between gap-8 rounded-3xl bg-deep p-6 text-white md:p-7">
      <div className="flex items-start justify-between gap-4 text-[14px] text-deep-muted">
        <span>Treasury on Arc</span>
        {t ? (
          <button
            onClick={() => {
              setOpen(!open);
              setErr(null);
            }}
            className="rounded-full bg-white/10 px-3 py-1 text-[13px] font-medium text-white transition hover:bg-white/20"
          >
            {open ? "Cancel" : "Withdraw"}
          </button>
        ) : (
          <span>USDC</span>
        )}
      </div>
      {open && (
        <div className="space-y-2.5">
          <input
            value={to}
            onChange={(e) => setTo(e.target.value)}
            placeholder="Recipient address (0x…)"
            className="mono w-full rounded-xl bg-white/10 px-3.5 py-2.5 text-[13px] text-white placeholder:text-deep-muted focus:outline-none focus:ring-2 focus:ring-white/40"
          />
          <div className="flex gap-2.5">
            <input
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              inputMode="decimal"
              placeholder="Amount (USDC)"
              className="num w-full flex-1 rounded-xl bg-white/10 px-3.5 py-2.5 text-[13px] text-white placeholder:text-deep-muted focus:outline-none focus:ring-2 focus:ring-white/40"
            />
            <button
              onClick={withdraw}
              disabled={busy || !to.trim() || !amount.trim()}
              className="rounded-xl bg-white px-4 py-2 text-[13px] font-semibold text-deep transition hover:bg-white/90 disabled:opacity-40"
            >
              {busy ? "Signing…" : "Send"}
            </button>
          </div>
          {err && <p className="text-[13px] text-[#ffb4ad]">{err}</p>}
          <p className="text-[12px] leading-relaxed text-deep-muted">
            Signed with your owner key — the agent can't do this.
          </p>
        </div>
      )}
      <div>
        <div className="num text-[44px] font-bold leading-none tracking-[-0.03em] md:text-[56px]">
          {t ? <Money value={t.usdcBalance} /> : <span className="font-light text-deep-muted">—</span>}
        </div>
        <div className="mt-4 flex items-center gap-2 text-[14px] text-deep-muted">
          {t ? (
            <>
              <span className="mono tracking-[0.04em]">
                {t.address.slice(0, 6)} ···· {t.address.slice(-4)}
              </span>
              <CopyButton text={t.address} dark />
            </>
          ) : (
            "Not configured"
          )}
        </div>
      </div>
    </div>
  );
}

function Figure({
  label,
  value,
  sub,
  copy,
  wait,
}: {
  label: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
  copy?: string;
  wait?: boolean;
}) {
  return (
    <div className="flex flex-col justify-between gap-6 px-4 py-4 sm:px-5 sm:py-5">
      <div className="text-[14px] text-ink-muted">{label}</div>
      <div>
        <div
          className={`num text-[30px] font-bold leading-none tracking-[-0.02em] ${wait ? "text-wait" : ""}`}
        >
          {value === "—" ? <span className="font-light text-ink-quiet">—</span> : value}
        </div>
        {sub && (
          <div
            className={`mt-2 flex items-center gap-1.5 text-[13px] ${wait ? "font-medium text-wait" : "text-ink-muted"}`}
          >
            <span>{sub}</span>
            {copy && <CopyButton text={copy} />}
          </div>
        )}
      </div>
    </div>
  );
}

function Step({ n, children }: { n: number; children: React.ReactNode }) {
  return (
    <li className="flex gap-4">
      <span className="num flex size-7 shrink-0 items-center justify-center rounded-full bg-mist text-[13px] font-semibold">
        {n}
      </span>
      <span className="pt-0.5">{children}</span>
    </li>
  );
}

function Profile({ onClose }: { onClose: () => void }) {
  const [me, setMe] = useState<Me | null>(null);
  const [authority, setAuthority] = useState<
    Awaited<ReturnType<typeof api.authority>>
  >([]);

  useEffect(() => {
    api.me().then(setMe).catch(() => {});
    api.authority().then(setAuthority).catch(() => {});
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-ink/25 px-4 py-16"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="profile-title"
        className="w-full max-w-lg rounded-3xl bg-canvas p-6 shadow-[0_24px_64px_-16px_rgba(26,29,36,0.28)] md:p-7"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-4">
          <h2 id="profile-title" className="text-[20px] font-medium tracking-[-0.015em]">
            Company profile
          </h2>
          <button onClick={onClose} className="btn btn-quiet btn-sm">
            Close
          </button>
        </div>
        {!me ? (
          <p className="py-10 text-[14px] text-ink-muted">Loading…</p>
        ) : (
          <div className="mt-5">
            <dl className="divide-y divide-line">
              <KV label="Organization" value={me.name} />
              <KV label="Org id" value={<span className="mono">{me.orgId}</span>} />
              <KV label="Per-payment cap" value={`$${me.perTxCapUsdc}`} num />
              <KV label="Daily budget" value={`$${me.dailyCapUsdc}`} num />
              {me.ensName && (
                <KV
                  label="ENS name"
                  value={
                    <span className="inline-flex items-center gap-1.5">
                      {me.ensName}
                      <CopyButton text={me.ensName} />
                    </span>
                  }
                />
              )}
              {me.ensRegistry && (
                <KV
                  label="Payee registry"
                  value={
                    <a
                      href={`https://sepolia.etherscan.io/address/${me.ensRegistry}`}
                      target="_blank"
                      rel="noreferrer"
                      className="link mono"
                    >
                      {me.ensRegistry.slice(0, 10)}… ↗
                    </a>
                  }
                />
              )}
            </dl>

            <div className="mt-6 space-y-4">
              <Row
                label={`Treasury on ${me.chain}`}
                value={me.treasuryAddress}
                mono
                copyable
                href={`https://testnet.arcscan.app/address/${me.treasuryAddress}`}
              />
              <Row label="Petty cash (x402 via Gateway)" value={me.pettyCashAddress} mono copyable />
            </div>

            <div className="mt-7">
              <h3 className="text-[15px] font-medium">Payment authority</h3>
              <p className="mt-0.5 text-[13px] text-ink-muted">
                Enforced by Privy policy at signing time.
              </p>
              {authority.length === 0 ? (
                <p className="mt-3 text-[14px] text-ink-muted">
                  None yet. Grant it in chat; the agent asks you to confirm each address and cap.
                </p>
              ) : (
                <table className="mt-3 w-full text-[14px]">
                  <tbody>
                    {authority.map((a) => (
                      <tr key={a.address} className="border-b border-line last:border-0">
                        <td className="py-2.5 pr-3">{a.label}</td>
                        <td className="mono py-2.5 pr-3 text-ink-muted">
                          {a.address.slice(0, 8)}…{a.address.slice(-6)}
                        </td>
                        <td className="whitespace-nowrap py-2.5 text-right">
                          Up to <span className="num font-semibold">${a.capUsdc}</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            <p className="mt-7 rounded-2xl bg-mist p-4 text-[13px] leading-relaxed text-ink-muted">
              AutoCFO custodies the keys, ENS name and AI. The agent signs with a policy-bounded
              key; payments over the mandate need your approval, executed with an owner key the
              agent never holds.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

function KV({ label, value, num }: { label: string; value: React.ReactNode; num?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-6 py-3">
      <dt className="text-[14px] text-ink-muted">{label}</dt>
      <dd className={`min-w-0 text-right text-[14px] ${num ? "num font-semibold" : ""}`}>{value}</dd>
    </div>
  );
}

// Signing out must ALSO end the Privy session — otherwise the onboarding
// screen's auto-login sees the still-authenticated Privy user and logs
// straight back in (infinite loop).
function PrivySignOutButton() {
  const { logout } = usePrivy();
  const [busy, setBusy] = useState(false);
  return (
    <button
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          await logout();
        } finally {
          clearToken();
          location.reload();
        }
      }}
      className="btn btn-secondary"
    >
      {busy ? "Signing out…" : "Sign out"}
    </button>
  );
}

function PrivyAuthPanel({
  onLoggedIn,
  onNeedsCreate,
}: {
  onLoggedIn: (token: string) => Promise<void>;
  onNeedsCreate: (session: { email: string; token: string }) => void;
}) {
  const { ready, authenticated, user, login, logout, getAccessToken } = usePrivy();
  const [checking, setChecking] = useState(false);
  const [session, setSession] = useState<{ email: string } | null>(null);
  const attempted = useRef(false);

  useEffect(() => {
    if (!ready || !authenticated || attempted.current) return;
    attempted.current = true;
    (async () => {
      setChecking(true);
      try {
        const token = (await getAccessToken()) ?? "";
        try {
          const r = await api.privyLogin(token);
          await onLoggedIn(r.token);
        } catch (e) {
          if ((e as { status?: number }).status === 404) {
            const email = user?.email?.address ?? "";
            setSession({ email });
            onNeedsCreate({ email, token });
          } else {
            throw e;
          }
        }
      } catch {
        attempted.current = false;
      } finally {
        setChecking(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, authenticated]);

  if (!ready) return null;
  if (!authenticated) {
    return (
      <button onClick={login} className="btn btn-secondary w-full">
        Sign in with Privy
      </button>
    );
  }
  if (checking) {
    return <p className="text-[14px] text-ink-muted">Checking your account…</p>;
  }
  if (session) {
    return (
      <div className="flex items-center justify-between rounded-2xl bg-mist px-4 py-3 text-[14px]">
        <span>
          Signed in as <strong>{session.email}</strong> — no org yet, create one below.
        </span>
        <button
          onClick={() => {
            attempted.current = false;
            setSession(null);
            logout();
          }}
          className="link"
        >
          switch
        </button>
      </div>
    );
  }
  return null;
}

function Onboarding({
  onDone,
  onCancel,
}: {
  onDone: () => Promise<void>;
  onCancel?: () => void;
}) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [perTx, setPerTx] = useState("10");
  const [daily, setDaily] = useState("200");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [result, setResult] = useState<OnboardResult | null>(null);
  const [steps, setSteps] = useState<{ label: string; status: "running" | "done" }[]>([]);
  const [privySession, setPrivySession] = useState<{ email: string; token: string } | null>(null);

  const submit = async () => {
    if (PRIVY_ENABLED && !privySession)
      return setErr("Sign in with Privy first — that's how we verify your email.");
    const effectiveEmail = privySession?.email ?? email.trim();
    if (!name.trim() || !effectiveEmail)
      return setErr("Enter an organization name and email.");
    setBusy(true);
    setErr(null);
    setSteps([]);
    try {
      const { jobId } = await api.onboard(
        { name: name.trim(), email: effectiveEmail, perTxCapUsdc: perTx, dailyCapUsdc: daily },
        privySession?.token,
      );
      // Poll the job for step-by-step progress until it finishes.
      const poll = async (): Promise<void> => {
        const job = await api.onboardStatus(jobId);
        setSteps(job.steps);
        if (job.error) throw new Error(job.error);
        if (job.result) {
          setToken(job.result.token);
          setResult(job.result);
          return;
        }
        await new Promise((r) => setTimeout(r, 1500));
        return poll();
      };
      await poll();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (result) {
    return (
      <div className="mx-auto flex min-h-screen w-full max-w-xl flex-col justify-center px-4 py-16 sm:px-6">
        <Wordmark />
        <h1 className="mt-10 text-[34px] font-medium leading-[1.1] tracking-[-0.03em] md:text-[40px]">
          <span className="block">Welcome, {name}.</span>
          <span className="block text-ink-quiet">Your treasury is ready.</span>
        </h1>
        <div className="mt-8 space-y-5 rounded-3xl bg-mist p-6">
          <Row label="Org id" value={result.orgId} mono />
          <Row label="Treasury on Arc" value={result.treasuryAddress} mono copyable />
          <Row label="Petty cash" value={result.pettyCashAddress} mono copyable />
          {result.ensName && <Row label="ENS name" value={result.ensName} mono />}
          <div className="rounded-2xl bg-canvas p-4">
            <Row
              label="Access token. It's shown once, so save it now."
              value={result.token}
              mono
              copyable
            />
          </div>
        </div>
        <p className="mt-5 text-[14px] leading-relaxed text-ink-muted">
          Your treasury starts empty. Fund both addresses with Arc testnet USDC at
          faucet.circle.com, then grant payment authority to your first payee in chat. AutoCFO
          custodies the keys, your ENS name and the AI; you make the decisions.
        </p>
        <button onClick={() => onDone()} className="btn btn-primary btn-lg mt-8 self-start">
          Open my dashboard
        </button>
      </div>
    );
  }

  return (
    <div className="mx-auto flex min-h-screen w-full max-w-[560px] flex-col justify-center px-4 py-16 sm:px-6">
      <Wordmark />
      <h1 className="mt-10 text-[36px] font-medium leading-[1.08] tracking-[-0.035em] md:text-[44px]">
        <span className="block">An autonomous CFO for your company.</span>
        <span className="block text-ink-quiet">Every payment inside limits you set.</span>
      </h1>
      <div className="mt-10 space-y-4">
        <label className="block">
          <span className="field-label">Organization name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} className="field mt-1.5" />
        </label>
        {PRIVY_ENABLED && (
          <PrivyAuthPanel
            onLoggedIn={async (token) => {
              setToken(token);
              await onDone();
            }}
            onNeedsCreate={(session) => setPrivySession(session)}
          />
        )}
        {!PRIVY_ENABLED && (
          <label className="block">
            <span className="field-label">Your email</span>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && submit()}
              className="field mt-1.5"
            />
          </label>
        )}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <label className="block">
            <span className="field-label">Per-payment cap</span>
            <span className="relative mt-1.5 block">
              <input
                inputMode="decimal"
                value={perTx}
                onChange={(e) => setPerTx(e.target.value)}
                className="field num pr-16"
              />
              <span className="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 text-[13px] text-ink-muted">
                USDC
              </span>
            </span>
          </label>
          <label className="block">
            <span className="field-label">Daily budget</span>
            <span className="relative mt-1.5 block">
              <input
                inputMode="decimal"
                value={daily}
                onChange={(e) => setDaily(e.target.value)}
                className="field num pr-16"
              />
              <span className="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 text-[13px] text-ink-muted">
                USDC
              </span>
            </span>
          </label>
        </div>
        <button onClick={submit} disabled={busy} className="btn btn-primary btn-lg !mt-6 w-full">
          {busy ? "Setting up treasury, policy and ENS name (about a minute)…" : "Create my CFO"}
        </button>
        {busy && steps.length > 0 && (
          <ol className="space-y-1.5 rounded-2xl bg-mist p-4 text-[14px]">
            {steps.map((st) => (
              <li key={st.label} className="flex items-center gap-2">
                {st.status === "done" ? (
                  <span className="text-paid">✓</span>
                ) : (
                  <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-line-strong border-t-signal" />
                )}
                <span className={st.status === "done" ? "text-ink-muted" : ""}>{st.label}</span>
              </li>
            ))}
          </ol>
        )}
        {err && (
          <p role="alert" className="text-[14px] text-stop">
            {err}
          </p>
        )}
        <p className="text-[13px] leading-relaxed text-ink-muted">
          We set up a Privy organization wallet with a spending mandate enforced in a secure
          enclave, a petty-cash account for x402 micropayments, and an ENS name. AutoCFO custodies
          all three.
        </p>
      </div>
      <ExistingToken onDone={onDone} />
      {onCancel && (
        <button onClick={onCancel} className="btn btn-quiet -ml-3 mt-4 self-start">
          Back to dashboard
        </button>
      )}
    </div>
  );
}

function ExistingToken({ onDone }: { onDone: () => Promise<void> }) {
  const [tok, setTok] = useState("");
  return (
    <div className="mt-8 border-t border-line pt-6">
      <label htmlFor="existing-token" className="field-label">
        Already have an access token?
      </label>
      <div className="mt-1.5 flex gap-2">
        <input
          id="existing-token"
          value={tok}
          onChange={(e) => setTok(e.target.value)}
          placeholder="Paste your token"
          className="field mono min-w-0 flex-1"
        />
        <button
          onClick={async () => {
            if (!tok.trim()) return;
            setToken(tok.trim());
            await onDone();
          }}
          className="btn btn-secondary shrink-0"
        >
          Use token
        </button>
      </div>
    </div>
  );
}

function Row({
  label,
  value,
  mono,
  copyable,
  href,
}: {
  label: string;
  value: string;
  mono?: boolean;
  copyable?: boolean;
  href?: string;
}) {
  return (
    <div>
      <div className="text-[13px] text-ink-muted">{label}</div>
      <div className={`mt-1 flex items-start gap-1.5 text-[14px] ${mono ? "mono" : ""}`}>
        <span className="min-w-0 break-all pt-0.5">{value}</span>
        {copyable && <CopyButton text={value} />}
        {href && (
          <a
            href={href}
            target="_blank"
            rel="noreferrer"
            aria-label="Open in block explorer"
            className="link shrink-0 pt-0.5"
          >
            ↗
          </a>
        )}
      </div>
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
  const logRef = useRef<HTMLDivElement>(null);

  // Scroll the conversation, never the page: on narrow screens the chat sits
  // below the ledger, and scrollIntoView would pull the page down on load.
  useEffect(() => {
    const el = logRef.current;
    if (!el || msgs.length === 0) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    el.scrollTo({ top: el.scrollHeight, behavior: reduce ? "auto" : "smooth" });
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
    <div className="flex flex-col rounded-3xl bg-mist">
      {msgs.length > 0 && (
        <div className="flex justify-end px-3 pt-3">
          <button onClick={clear} className="btn btn-quiet btn-sm">
            Clear conversation
          </button>
        </div>
      )}
      <div
        ref={logRef}
        aria-live="polite"
        className="max-h-[34rem] min-h-72 space-y-3 overflow-y-auto p-4"
      >
        {msgs.length === 0 && (
          <p className="px-1 text-[14px] leading-relaxed text-ink-muted">
            Try: “onboard a new payee called karan with address 0x… and set up 8 USDC a month.”
            The agent asks you before granting payment authority.
          </p>
        )}
        {msgs.map((m, i) =>
          m.role === "user" ? (
            <div key={i} className="flex justify-end">
              <div className="max-w-[85%] rounded-[20px] rounded-br-md bg-deep px-4 py-2.5 text-[14px] leading-relaxed text-white">
                {m.text}
              </div>
            </div>
          ) : (
            <div key={i} className="max-w-[92%]">
              <div className="rounded-[20px] rounded-bl-md bg-canvas px-4 py-3">
                <p className="whitespace-pre-wrap text-[14px] leading-relaxed">
                  <Rich text={m.text} />
                </p>
              </div>
              {m.tools && m.tools.length > 0 && (
                <p className="mono mt-1.5 px-2 text-[11px] text-ink-muted">
                  {m.tools.join(" → ")}
                </p>
              )}
            </div>
          ),
        )}
        {busy && <div className="px-1 text-[14px] text-ink-muted">Thinking…</div>}
      </div>
      <div className="p-2 pt-0">
        <div className="flex items-center gap-2 rounded-full bg-canvas p-1.5 pl-5 ring-1 ring-line focus-within:ring-2 focus-within:ring-sky">
          <input
            aria-label="Message your CFO"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && send()}
            placeholder="Message your CFO…"
            disabled={busy}
            className="min-w-0 flex-1 bg-transparent text-[14px] outline-none placeholder:text-ink-quiet disabled:opacity-50"
          />
          <button onClick={send} disabled={busy || !draft.trim()} className="btn btn-primary btn-sm">
            Send
            <Icon name="arrowUp" />
          </button>
        </div>
      </div>
    </div>
  );
}

function usePayees(open: boolean, payeeId: string, setPayeeId: (id: string) => void) {
  const [payees, setPayees] = useState<Payee[]>([]);
  useEffect(() => {
    if (open) {
      api.payees().then((p) => {
        setPayees(p);
        if (p.length && !payeeId) setPayeeId(p[0].id);
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  return payees;
}

function NewRecurring({ onCreated }: { onCreated: () => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [payeeId, setPayeeId] = useState("");
  const [amount, setAmount] = useState("");
  const [memo, setMemo] = useState("");
  const [intervalDays, setIntervalDays] = useState("30");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const payees = usePayees(open, payeeId, setPayeeId);

  const submit = async () => {
    if (!payeeId || !amount || !memo) {
      setErr("Fill in payee, amount and memo.");
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      await api.createRecurring({
        payeeId,
        amountUsdc: amount,
        memo,
        intervalDays: Number(intervalDays),
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
      <button onClick={() => setOpen(true)} className="btn btn-secondary btn-sm">
        <Icon name="repeat" />
        Recurring payment
      </button>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-2xl bg-mist p-2">
      <select
        aria-label="Payee"
        value={payeeId}
        onChange={(e) => setPayeeId(e.target.value)}
        className="field field-sm"
      >
        {payees.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>
      <input
        aria-label="Amount in USDC"
        inputMode="decimal"
        value={amount}
        onChange={(e) => setAmount(e.target.value)}
        placeholder="USDC"
        className="field field-sm num w-20"
      />
      <input
        aria-label="Memo"
        value={memo}
        onChange={(e) => setMemo(e.target.value)}
        placeholder="Memo, e.g. retainer"
        className="field field-sm w-40"
      />
      <select
        aria-label="How often"
        value={intervalDays}
        onChange={(e) => setIntervalDays(e.target.value)}
        className="field field-sm"
      >
        <option value="7">Weekly</option>
        <option value="14">Every 2 weeks</option>
        <option value="30">Monthly</option>
      </select>
      <button onClick={submit} disabled={busy} className="btn btn-primary btn-sm">
        {busy ? "Adding…" : "Add payment"}
      </button>
      <button onClick={() => setOpen(false)} className="btn btn-quiet btn-sm">
        Cancel
      </button>
      {err && <span className="basis-full px-1 text-[13px] text-stop">{err}</span>}
    </div>
  );
}

function NewInvoice({ onCreated }: { onCreated: () => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [payeeId, setPayeeId] = useState("");
  const [amount, setAmount] = useState("");
  const [memo, setMemo] = useState("");
  const [dueInDays, setDueInDays] = useState("0");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const payees = usePayees(open, payeeId, setPayeeId);

  const submit = async () => {
    if (!payeeId || !amount || !memo) {
      setErr("Fill in payee, amount and memo.");
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
      <button onClick={() => setOpen(true)} className="btn btn-secondary btn-sm">
        <Icon name="plus" />
        New invoice
      </button>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-2xl bg-mist p-2">
      <select
        aria-label="Payee"
        value={payeeId}
        onChange={(e) => setPayeeId(e.target.value)}
        className="field field-sm"
      >
        {payees.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>
      <input
        aria-label="Amount in USDC"
        inputMode="decimal"
        value={amount}
        onChange={(e) => setAmount(e.target.value)}
        placeholder="USDC"
        className="field field-sm num w-20"
      />
      <input
        aria-label="Memo"
        value={memo}
        onChange={(e) => setMemo(e.target.value)}
        placeholder="Memo"
        className="field field-sm w-40"
      />
      <select
        aria-label="Due date"
        value={dueInDays}
        onChange={(e) => setDueInDays(e.target.value)}
        className="field field-sm"
      >
        <option value="-1">Overdue</option>
        <option value="0">Due today</option>
        <option value="3">Due in 3 days</option>
        <option value="14">Due in 14 days</option>
      </select>
      <button onClick={submit} disabled={busy} className="btn btn-primary btn-sm">
        {busy ? "Adding…" : "Add invoice"}
      </button>
      <button onClick={() => setOpen(false)} className="btn btn-quiet btn-sm">
        Cancel
      </button>
      {err && <span className="basis-full px-1 text-[13px] text-stop">{err}</span>}
    </div>
  );
}

function CopyButton({ text, dark }: { text: string; dark?: boolean }) {
  const [copied, setCopied] = useState(false);
  const idle = dark
    ? "text-deep-muted hover:bg-white/10 hover:text-white"
    : "text-ink-quiet hover:bg-ink/5 hover:text-ink";
  return (
    <button
      type="button"
      title={`Copy ${text}`}
      aria-label={copied ? "Copied" : "Copy"}
      onClick={async () => {
        await navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
      className={`inline-flex size-6 shrink-0 items-center justify-center rounded-full transition-colors ${
        copied ? (dark ? "text-white" : "text-paid") : idle
      }`}
    >
      {copied ? (
        "✓"
      ) : (
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
          <rect x="5.5" y="5.5" width="9" height="9" rx="1.5" />
          <path d="M10.5 5.5V2.5a1 1 0 0 0-1-1h-7a1 1 0 0 0-1 1v7a1 1 0 0 0 1 1h3" />
        </svg>
      )}
    </button>
  );
}
