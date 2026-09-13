import { generateText, stepCountIs, type ModelMessage } from "ai";
import { getModel } from "./provider.js";
import { cfoTools } from "./tools.js";
import { materializeRecurring } from "./recurring.js";

const SYSTEM = `You are AutoCFO, the autonomous CFO agent for a small company. You manage the treasury under a hard mandate enforced by Privy's policy engine (payee allowlist, per-transaction cap, rolling daily budget) — the policy engine, not you, is the final guardrail, so act decisively within it.

Your operating rules:
1. Every disbursement must trace to a concrete signal: an invoice that is due, a budget state, a top-up threshold. Never pay without one.
2. Pay pending invoices that are due (or overdue): use pay_invoice for payees on Arc, and payout_cross_chain for payees whose preferred chain is not Arc (Gateway mints on their chain). If a human asks you to pay someone and no invoice exists yet, CREATE one with create_invoice first, then pay it. If the policy denies a payment, do NOT retry — escalate with propose_approval and a crisp justification a human approver can act on.
3. Before paying, check treasury state. If paying an invoice would leave less than 20% of the current balance, escalate instead of paying, even if policy would allow it.
4. Watch for anomalies: duplicate invoices (same payee, same amount, close due dates), amounts wildly above a payee's history, or payees not on the allowlist. For duplicates, pay the EARLIER-created invoice normally and flag only the later copy.
5. When asked to onboard a payee AND set up regular payments, do both: onboard_payee first (its result includes the payeeId), then create_recurring_payment with that exact payeeId — the schedule generates invoices automatically each interval. If you ever lack a payeeId, call list_payees; never guess ids.
6. Payment authority is a HUMAN decision. Onboarding gives a payee an identity, not money. Before calling grant_payment_authority you must have, in this conversation, an explicit human confirmation of BOTH the address and the per-payment cap. When a request implies paying someone new, first do the identity work, then ASK: "Should I add <name> (<address>) to the payment allowlist, and what per-payment cap?" Wait for the answer. Never invent a cap.
7. You are in a conversation: when a request is ambiguous or needs a human decision, ask a short, concrete question instead of guessing. Once the human answers, act without re-asking.
8. Be concise: say what you did, what you're asking, and why.`;

export async function runCfoTick(instruction?: string) {
  // Standing schedules become real invoices BEFORE the model runs — payroll
  // amounts and dates come from code, never from the LLM.
  const started = Date.now();
  const materialized = materializeRecurring();
  if (materialized) console.log(`[tick] materialized ${materialized} recurring invoice(s)`);
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
  console.log(
    `[tick] done in ${Date.now() - started}ms tools=[${result.steps.flatMap((s) => s.toolCalls.map((c) => c.toolName)).join(",")}]`,
  );
  return {
    summary: result.text,
    steps: result.steps.map((s) => ({
      toolCalls: s.toolCalls.map((c) => ({ tool: c.toolName, input: c.input })),
    })),
  };
}

// ---- Multi-turn chat (histories live in process memory, keyed by org) ----

import { currentOrg } from "./org.js";

const chatHistories = new Map<string, ModelMessage[]>();

export function resetChat() {
  chatHistories.delete(currentOrg().orgId);
}

export async function runCfoChat(userMessage: string) {
  materializeRecurring();
  const orgId = currentOrg().orgId;
  let chatHistory = chatHistories.get(orgId) ?? [];
  chatHistories.set(orgId, chatHistory);
  chatHistory.push({ role: "user", content: userMessage });
  const result = await generateText({
    model: getModel(),
    system: SYSTEM,
    messages: chatHistory,
    tools: cfoTools,
    stopWhen: stepCountIs(Number(process.env.AGENT_MAX_STEPS ?? 10)),
    maxOutputTokens: Number(process.env.AGENT_MAX_OUTPUT_TOKENS ?? 1200),
  });
  // Keep the full assistant/tool trace so follow-up turns have context.
  chatHistory.push(...result.response.messages);
  // Trim runaway histories (cost control): keep the last 40 messages.
  if (chatHistory.length > 40) {
    chatHistory = chatHistory.slice(-40);
    chatHistories.set(orgId, chatHistory);
  }
  const toolsUsed = result.steps.flatMap((s) => s.toolCalls.map((c) => c.toolName));
  console.log(`[chat:${orgId}] turn done tools=[${toolsUsed.join(",")}]`);
  return { reply: result.text, toolsUsed };
}
