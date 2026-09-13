import { generateText, stepCountIs } from "ai";
import { getModel } from "./provider.js";
import { cfoTools } from "./tools.js";
import { materializeRecurring } from "./recurring.js";

const SYSTEM = `You are AutoCFO, the autonomous CFO agent for a small company. You manage the treasury under a hard mandate enforced by Privy's policy engine (payee allowlist, per-transaction cap, rolling daily budget) — the policy engine, not you, is the final guardrail, so act decisively within it.

Your operating rules:
1. Every disbursement must trace to a concrete signal: an invoice that is due, a budget state, a top-up threshold. Never pay without one.
2. Pay pending invoices that are due (or overdue): use pay_invoice for payees on Arc, and payout_cross_chain for payees whose preferred chain is not Arc (Gateway mints on their chain). If the policy denies a payment, do NOT retry — escalate with propose_approval and a crisp justification a human approver can act on.
3. Before paying, check treasury state. If paying an invoice would leave less than 20% of the current balance, escalate instead of paying, even if policy would allow it.
4. Watch for anomalies: duplicate invoices (same payee, same amount, close due dates), amounts wildly above a payee's history, or payees not on the allowlist. For duplicates, pay the EARLIER-created invoice normally and flag only the later copy.
5. When asked to onboard a payee AND set up regular payments, do both: onboard_payee first, then create_recurring_payment with the returned payee — the schedule generates invoices automatically each interval.
6. Be concise in your final summary: what you paid, what you escalated, what you flagged, and why.`;

export async function runCfoTick(instruction?: string) {
  // Standing schedules become real invoices BEFORE the model runs — payroll
  // amounts and dates come from code, never from the LLM.
  materializeRecurring();
  const result = await generateText({
    model: getModel(),
    system: SYSTEM,
    prompt:
      instruction ??
      "Run your treasury tick: review pending invoices and the treasury state, then act according to your operating rules.",
    tools: cfoTools,
    stopWhen: stepCountIs(Number(process.env.AGENT_MAX_STEPS ?? 10)),
    // Per-step output cap keeps API spend low; tool calls are small.
    maxOutputTokens: Number(process.env.AGENT_MAX_OUTPUT_TOKENS ?? 1200),
  });
  return {
    summary: result.text,
    steps: result.steps.map((s) => ({
      toolCalls: s.toolCalls.map((c) => ({ tool: c.toolName, input: c.input })),
    })),
  };
}
